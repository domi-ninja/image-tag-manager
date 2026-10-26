import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyRuntimeArchive } from './runtime-archive.mjs';

test('runtime verification accepts pinned bytes and rejects tampering or a missing digest', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'runtime-archive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = path.join(directory, 'runtime.tar.gz');
  const digest = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  await writeFile(archive, 'abc');
  await verifyRuntimeArchive(archive, digest);
  await assert.rejects(verifyRuntimeArchive(archive), /Missing or invalid/);
  await writeFile(archive, 'changed');
  await assert.rejects(verifyRuntimeArchive(archive, digest), /mismatch/);
});
