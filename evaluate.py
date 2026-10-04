"""Run local models on every random image; preserve raw output and timings."""
import argparse
import hashlib
import json
import statistics
import time
from pathlib import Path

import torch
from PIL import Image

ROOT = Path(__file__).resolve().parent
PROMPT = ('Identify the main visible subjects and scene. Return only a JSON object with '
          '"tags": an array of 5 to 8 short descriptive tags, and "caption": one concise sentence. '
          'Describe only what is visibly supported. Avoid guessing exact locations, species, '
          'brands, or identities unless unmistakable.')


def run_qwen(paths, threads):
    from transformers import AutoProcessor, Qwen3VLForConditionalGeneration
    model_path = ROOT / 'models/Qwen3-VL-2B-Instruct'
    started = time.perf_counter()
    processor = AutoProcessor.from_pretrained(model_path, local_files_only=True)
    model = Qwen3VLForConditionalGeneration.from_pretrained(
        model_path, local_files_only=True, dtype=torch.bfloat16,
        attn_implementation='sdpa').eval()
    load_seconds = time.perf_counter() - started
    rows = []
    for path in paths:
        started = time.perf_counter()
        image = Image.open(path).convert('RGB')
        messages = [{'role':'user', 'content':[
            {'type':'image', 'image':image}, {'type':'text', 'text':PROMPT}]}]
        inputs = processor.apply_chat_template(messages, tokenize=True,
            add_generation_prompt=True, return_dict=True, return_tensors='pt')
        with torch.inference_mode():
            output = model.generate(**inputs, max_new_tokens=160, do_sample=False)
        generated = output[0, inputs['input_ids'].shape[1]:]
        raw = processor.decode(generated, skip_special_tokens=True)
        seconds = time.perf_counter() - started
        cleaned = raw.strip().removeprefix('```json').removeprefix('```').removesuffix('```').strip()
        try:
            parsed = json.loads(cleaned)
        except json.JSONDecodeError:
            parsed = None
        row = dict(image=path.name, raw=raw, parsed=parsed, seconds=seconds,
                   generated_tokens=len(generated))
        rows.append(row)
        print(json.dumps(row), flush=True)
        save('qwen', rows, load_seconds, threads, prompt=PROMPT, dtype='bfloat16',
             max_new_tokens=160, do_sample=False)


def save(name, rows, load_seconds, threads, **extra):
    result = dict(model=name, device='cpu', threads=threads, load_seconds=load_seconds,
        median_seconds=statistics.median(r['seconds'] for r in rows),
        annotations_sha256=hashlib.sha256((ROOT/'samples/annotations.json').read_bytes()).hexdigest(),
        results=rows, **extra)
    (ROOT/f'results/{name}.json').write_text(json.dumps(result, indent=2) + '\n')


def run_encoder(name, paths, threads):
    annotations = json.loads((ROOT/'samples/annotations.json').read_text())
    labels = annotations['candidate_labels']
    texts = [f'This is a photo of {label}.' for label in labels]
    started = time.perf_counter()
    if name == 'siglip':
        from transformers import AutoModel, AutoProcessor
        model_path = ROOT/'models/siglip2-base-patch16-224'
        processor = AutoProcessor.from_pretrained(model_path, local_files_only=True)
        model = AutoModel.from_pretrained(model_path, local_files_only=True).eval()
        with torch.inference_mode():
            features = model.get_text_features(**processor(text=texts,
                padding='max_length', max_length=64, return_tensors='pt'))
            if not isinstance(features, torch.Tensor):
                features = features.pooler_output
            features = torch.nn.functional.normalize(features, dim=-1)
        def image_features(image):
            result = model.get_image_features(**processor(images=image, return_tensors='pt'))
            return result if isinstance(result, torch.Tensor) else result.pooler_output
    else:
        import open_clip
        from timm.utils import reparameterize_model
        model_id = 'local-dir:' + str(ROOT/'models/MobileCLIP2-S2-OpenCLIP')
        model, _, preprocess = open_clip.create_model_and_transforms(model_id)
        model = reparameterize_model(model.eval())
        # Apple's OpenCLIP recipe uses zero padding. The HF tokenizer bundled
        # with this port pads with EOS, which breaks its non-causal text encoder.
        tokenizer = open_clip.get_tokenizer('MobileCLIP2-S2')
        with torch.inference_mode():
            features = model.encode_text(tokenizer(texts), normalize=True)
        def image_features(image):
            return model.encode_image(preprocess(image).unsqueeze(0))
    load_seconds = time.perf_counter() - started
    rows = []
    with torch.inference_mode():
        image_features(Image.open(paths[0]).convert('RGB'))  # Untimed warm-up.
        for path in paths:
            started = time.perf_counter()
            image = Image.open(path).convert('RGB')
            image_embedding = torch.nn.functional.normalize(image_features(image), dim=-1)
            similarity = (image_embedding @ features.T)[0]
            values, indices = similarity.topk(5)
            predictions = [dict(label=labels[i], cosine_similarity=float(v))
                           for i, v in zip(indices.tolist(), values.tolist())]
            expected = next(r['category'] for r in annotations['images'] if r['index']==int(path.stem))
            row = dict(image=path.name, expected=expected, predictions=predictions,
                       correct=predictions[0]['label']==expected, seconds=time.perf_counter()-started)
            rows.append(row)
            print(json.dumps(row), flush=True)
    save(name, rows, load_seconds, threads, candidate_labels=labels,
         top1=sum(r['correct'] for r in rows)/len(rows),
         top5=sum(any(p['label']==r['expected'] for p in r['predictions']) for r in rows)/len(rows),
         prompt_template='This is a photo of {label}.', dtype='float32')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('model', choices=['qwen','siglip','mobileclip'])
    parser.add_argument('--threads', type=int, default=8)
    args = parser.parse_args()
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    paths = sorted((ROOT/'samples').glob('[0-9][0-9].jpg'))
    if args.model=='qwen':
        run_qwen(paths, args.threads)
    else:
        run_encoder(args.model, paths, args.threads)
