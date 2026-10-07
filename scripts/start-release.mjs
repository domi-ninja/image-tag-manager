// Launch the existing release binary without rebuilding or watching source files.
import { access } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';

const metadata = JSON.parse(
  execFileSync(
    'cargo',
    ['metadata', '--manifest-path', 'src-tauri/Cargo.toml', '--format-version', '1', '--no-deps'],
    { encoding: 'utf8' },
  ),
);
const binary = path.join(
  metadata.target_directory,
  'release',
  process.platform === 'win32' ? 'image-tag-manager.exe' : 'image-tag-manager',
);
try {
  await access(binary);
} catch {
  console.error('No release build found. Run pnpm build first, then pnpm start.');
  process.exit(1);
}
const child = spawn(binary, process.argv.slice(2), { stdio: 'inherit' });
child.on('error', (error) => {
  console.error(`Could not start Image Tag Manager: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
