import { readFileSync } from 'node:fs';
const version = JSON.parse(readFileSync('package.json')).version;
const tauri = JSON.parse(readFileSync('src-tauri/tauri.conf.json')).version;
const rust = readFileSync('src-tauri/Cargo.toml', 'utf8').match(/^version = "([^"]+)"/m)?.[1];
if (process.env.RELEASE_TAG !== `v${version}` || tauri !== version || rust !== version) {
  throw new Error('Release tag, package.json, tauri.conf.json and Cargo.toml versions must match.');
}
