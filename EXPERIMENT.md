# Local image classification experiment

Random-photo comparison on a Ryzen AI 9 HX 370, using CPU inference only.

For flexible tags, I recommend Qwen3-VL-2B-Instruct. For fast sorting into a supplied
list of categories, I recommend MobileCLIP2-S2. This is evidence of usefulness on
these photos, not a claim of universal accuracy.

| Model | Task and result on 20 random photos | Median CPU time/image | Weight file |
| --- | --- | --- | --- |
| Qwen3-VL-2B-Instruct | Main subjects right in 20/20 by assistant visual review; 13 clean passes, 7 with questionable specifics | 12.86 s | 3.96 GiB |
| MobileCLIP2-S2 | Matches predefined category on 19/20; expected category in top 5 on 20/20 | 65 ms | 380 MiB |
| SigLIP 2 Base | Matches predefined category on 18/20; expected category in top 5 on 20/20 | 90 ms | 1.40 GiB |

The free-tagging review and fixed-label match rates measure different tasks.
One image separates the two encoders, so this sample cannot establish a reliable
accuracy ranking between them. Timings come from one sequential run per model on
the user's active machine, not a controlled performance benchmark.

Inspect every photograph with the actual generated tags, caption, review, and both
classifiers' predictions: [photos 01-10](results/predictions-1.jpg),
[photos 11-20](results/predictions-2.jpg).
Raw outputs and timings are in [qwen.json](results/qwen.json),
[mobileclip.json](results/mobileclip.json), and [siglip.json](results/siglip.json).
[review.json](results/review.json) records the subjective judgments and annotation caveats.

Concrete findings:

- Qwen recognized the bride through the car window, audio mixer, football stadium,
  Eiffel Tower, and people on a white seaside cliff without receiving subject labels.
- Qwen sometimes added unsupported specifics: cherry species, sunrise/dawn, lakeside,
  and music studio. Its 20/20 main-subject result does not mean every tag was correct.
- Both encoders focused on the small car in photo 15 instead of the reference category,
  formal garden. Qwen described both the car/person and the lawn.
- SigLIP called photo 09 skyscrapers; MobileCLIP and Qwen identified the Eiffel Tower.
- Both Qwen and MobileCLIP selected `audio equipment` when separately tested with the
  five custom labels landscape, audio equipment, food, vehicle, and animal. The Qwen
  caption still assumed a studio setting. Raw outputs are retained in `results/`.


Models:

- Qwen/Qwen3-VL-2B-Instruct: generates tags and a caption without seeing candidate labels.
- google/siglip2-base-patch16-224: chooses among user-defined text labels.
- timm/MobileCLIP2-S2-OpenCLIP: smaller alternative for choosing text labels.

## Evidence and method

All 20 photos come from Lorem Picsum's seeded random endpoint, independently of model
repositories and demos. Seeds are `domi-local-classification-01` through `20`.
No draws were discarded or replaced. Original files, photographer credits, source
URLs and SHA-256 hashes are in `samples/` and `samples/sources.json`.

`annotations.json` records visual descriptions and expected categories made by the
assistant before inference. The fixed-label task uses 50 labels, including suitable
labels chosen after viewing the photos and unrelated alternatives. It is a practical
sorting demonstration, not a standard benchmark. Qwen never sees these annotations
or candidate labels when generating its tags.

The sample has many outdoor scenes and does not establish performance on documents,
screenshots, animals, or specialized images. Independent sourcing does not establish
absence from pretraining. The earlier proposed CIFAR-100 benchmark was superseded by
the random-photo test after the task was clarified; no CIFAR accuracy is claimed.

## Retained evidence

The original Python experiment scripts and environment have been removed. Their
source remains in Git history. The sample images, annotations, model revision
records, raw outputs, timings, and rendered comparison sheets remain in this repo.
The reported timings describe the original experiment, not the current desktop app.

To classify your own images with the native app, follow the [README](README.md).

## Inference settings

Qwen uses BF16 and greedy generation, up to 160 new tokens in the evaluation.
The encoders use FP32 and cache text embeddings. All use eight CPU threads.
Encoder latency includes image opening, preprocessing, inference and ranking after
one warm-up, excluding loading and text embedding. Qwen latency includes image
opening, preprocessing and generation; its first image is cold and retained.
Scores from the encoders are cosine similarities, not calibrated confidence.

## Sources

- [Qwen model card](https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct)
- [SigLIP 2 model card](https://huggingface.co/google/siglip2-base-patch16-224)
- [MobileCLIP2 model card](https://huggingface.co/timm/MobileCLIP2-S2-OpenCLIP)
- [Picsum random-image API](https://picsum.photos/)

## MobileCLIP setup detail

The final run uses the downloaded model's image preprocessing and the canonical
OpenCLIP `MobileCLIP2-S2` tokenizer. The bundled Hugging Face tokenizer pads with EOS;
the canonical tokenizer pads with zero. Using the bundled EOS padding collapsed text
similarities and produced invalid predictions. An earlier attempt also used default
CLIP image normalization instead of this model's 0-to-1 input normalization. These
setup errors were fixed before the reported comparison. No labels or prompts were
tuned in response to model predictions.
