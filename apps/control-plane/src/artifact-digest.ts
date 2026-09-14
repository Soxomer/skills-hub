import { createHash } from 'node:crypto'
import type { ArtifactBundleEntry } from '@ahm/contracts'

// See docs/architecture/ARTIFACT-IDENTITY.md and the shared golden fixture.
export function artifactDigest(entries: readonly ArtifactBundleEntry[]): string {
  const hash = createHash('sha256').update('AHM-ARTIFACT-V1\0')
  const length = (value: number) => {
    const bytes = Buffer.alloc(8)
    bytes.writeBigUInt64BE(BigInt(value))
    hash.update(bytes)
  }
  for (const entry of [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))) {
    const path = Buffer.from(entry.path)
    hash.update(entry.kind === 'file' ? 'F' : 'D')
    length(path.length)
    hash.update(path)
    if (entry.kind === 'file') {
      const bytes = Buffer.from(entry.contentBase64!, 'base64')
      length(bytes.length)
      hash.update(bytes)
    }
  }
  return `sha256:${hash.digest('hex')}`
}
