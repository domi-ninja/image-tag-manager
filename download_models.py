"""Download the exact model revisions used in this experiment."""
import json
from pathlib import Path
from huggingface_hub import snapshot_download

ROOT = Path(__file__).resolve().parent
for record in json.loads((ROOT/'results/model-revisions.json').read_text()):
    snapshot_download(record['repo'], revision=record['revision'],
        allow_patterns=['*.json', '*.safetensors', '*.model', '*.txt', '*.jinja'],
        local_dir=ROOT/'models'/record['repo'].split('/')[-1])
