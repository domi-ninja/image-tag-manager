import { mkdir, readdir, copyFile, rm, writeFile, chmod } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const tag = 'b11384';
const targets = {
  'linux-x64': 'ubuntu-x64.tar.gz',
  'win32-x64': 'win-cpu-x64.zip',
  'darwin-arm64': 'macos-arm64.tar.gz',
  'darwin-x64': 'macos-x64.tar.gz',
};
const target = targets[`${process.platform}-${process.arch}`];
if (!target)
  throw new Error(
    'No bundled runtime for this OS/architecture. Supported: Windows/Linux x64, macOS arm64/x64.',
  );
const dir = path.resolve('src-tauri/runtime');
const staging = path.resolve('.runtime-download');
await mkdir(staging, { recursive: true });
const archive = path.join(staging, target);
console.log(`Downloading llama.cpp ${tag} for ${process.platform}/${process.arch}`);
const response = await fetch(
  `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/llama-${tag}-bin-${target}`,
);
if (!response.ok || !response.body) throw new Error(`Runtime download: ${response.status}`);
await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
const unpack = path.join(staging, 'unpack');
await mkdir(unpack, { recursive: true });
if (target.endsWith('.zip'))
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      'Expand-Archive -LiteralPath $env:IMAGE_TAG_MANAGER_ARCHIVE -DestinationPath $env:IMAGE_TAG_MANAGER_UNPACK -Force',
    ],
    { env: { ...process.env, IMAGE_TAG_MANAGER_ARCHIVE: archive, IMAGE_TAG_MANAGER_UNPACK: unpack } },
  );
else execFileSync('tar', ['-xzf', archive, '-C', unpack]);
await mkdir(dir, { recursive: true });
async function collect(folder) {
  for (const item of await readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, item.name);
    if (item.isDirectory()) await collect(file);
    else if (/^(llama-server(?:\.exe)?|.*\.(?:dll|dylib)|.*\.so(?:\.\d+)*)$/.test(item.name)) {
      await copyFile(file, path.join(dir, item.name));
      if (process.platform !== 'win32') await chmod(path.join(dir, item.name), 0o755);
    }
  }
}
await collect(unpack);
const license = await fetch(`https://raw.githubusercontent.com/ggml-org/llama.cpp/${tag}/LICENSE`);
if (!license.ok) throw new Error('Could not retrieve runtime license');
await writeFile(path.join(dir, 'LLAMA-LICENSE.txt'), await license.text());
await writeFile(path.join(dir, 'version.txt'), `${tag}\n`);
await rm(staging, { recursive: true, force: true });
console.log(`Runtime ready in ${dir}`);
