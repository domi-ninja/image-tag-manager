"""Generate image tags with Qwen or rank supplied labels with MobileCLIP2."""
import argparse
import json
from pathlib import Path

import torch
from PIL import Image
from transformers import AutoProcessor, Qwen3VLForConditionalGeneration

from evaluate import PROMPT, ROOT


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('image', type=Path)
    parser.add_argument('--model', choices=['qwen', 'mobileclip'], default='qwen')
    parser.add_argument('--labels', nargs='+', help='Optional candidate categories to choose among.')
    parser.add_argument('--threads', type=int, default=8)
    args = parser.parse_args()
    if args.model == 'mobileclip' and not args.labels:
        parser.error('--model mobileclip requires --labels')
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    image = Image.open(args.image).convert('RGB')
    if args.model == 'mobileclip':
        import open_clip
        from timm.utils import reparameterize_model
        model_id = 'local-dir:' + str(ROOT/'models/MobileCLIP2-S2-OpenCLIP')
        model, _, preprocess = open_clip.create_model_and_transforms(model_id)
        model = reparameterize_model(model.eval())
        # Use the original OpenCLIP zero-padding tokenizer, matching evaluate.py.
        tokenizer = open_clip.get_tokenizer('MobileCLIP2-S2')
        with torch.inference_mode():
            texts = model.encode_text(tokenizer([
                f'This is a photo of {label}.' for label in args.labels]), normalize=True)
            features = model.encode_image(preprocess(image).unsqueeze(0), normalize=True)
            scores = (features @ texts.T)[0]
        order = scores.argsort(descending=True).tolist()
        print(json.dumps([{'label': args.labels[i], 'cosine_similarity': scores[i].item()}
                          for i in order], indent=2))
        return
    model_path = ROOT/'models/Qwen3-VL-2B-Instruct'
    processor = AutoProcessor.from_pretrained(model_path, local_files_only=True)
    model = Qwen3VLForConditionalGeneration.from_pretrained(model_path, local_files_only=True,
        dtype=torch.bfloat16, attn_implementation='sdpa').eval()
    prompt = PROMPT
    if args.labels:
        prompt += (' Also include "category": exactly one of these candidate labels, '
                   'or null if none fits: ' + json.dumps(args.labels) + '.')
    messages = [{'role':'user','content':[{'type':'image','image':image}, {'type':'text','text':prompt}]}]
    inputs = processor.apply_chat_template(messages, tokenize=True, add_generation_prompt=True,
        return_dict=True, return_tensors='pt')
    with torch.inference_mode():
        output = model.generate(**inputs, max_new_tokens=180, do_sample=False)
    print(processor.decode(output[0, inputs['input_ids'].shape[1]:], skip_special_tokens=True))


if __name__ == '__main__':
    main()
