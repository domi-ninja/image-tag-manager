import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

// Verify the pinned release bytes before an archive can supply native executables.
export async function verifyRuntimeArchive(archive, expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? '')) {
    throw new Error('Missing or invalid pinned runtime SHA-256');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== expectedSha256) {
    throw new Error('Runtime archive SHA-256 mismatch; refusing to extract it');
  }
}
