"""Download a fixed, unfiltered sequence of random Picsum photographs."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen


def download(index):
    seed = f'domi-local-classification-{index:02d}'
    url = f'https://picsum.photos/seed/{seed}/640/480'
    path = Path(f'samples/{index:02d}.jpg')
    with urlopen(url, timeout=90) as response:
        data = response.read()
        image_id = response.headers['Picsum-ID']
        resolved = response.url
    path.write_bytes(data)
    with urlopen(f'https://picsum.photos/id/{image_id}/info', timeout=90) as response:
        info = json.load(response)
    return dict(index=index, path=str(path), seed=seed, request_url=url,
                resolved_url=resolved, sha256=hashlib.sha256(data).hexdigest(), **info)


if __name__ == '__main__':
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        records = list(pool.map(download, range(1, 21)))
    Path('samples/sources.json').write_text(json.dumps(records, indent=2) + '\n')
    print(f'Downloaded {len(records)} images, no content filtering.', flush=True)
