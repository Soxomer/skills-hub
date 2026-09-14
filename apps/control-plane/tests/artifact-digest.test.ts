import { readFileSync } from 'node:fs'
import type { ArtifactBundle } from '@ahm/contracts'
import { describe, expect, it } from 'vitest'
import { artifactDigest } from '../src/artifact-digest.js'

describe('canonical artifact identity', () => {
  it('matches the Rust golden fixture independently of entry order', () => {
    const fixture = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/artifacts/canonical-v1.json', import.meta.url), 'utf8')) as ArtifactBundle
    expect(artifactDigest(fixture.entries)).toBe(fixture.contentDigest)
    expect(artifactDigest([...fixture.entries].reverse())).toBe(fixture.contentDigest)
  })

  it('frames file names separately from their content', () => {
    expect(artifactDigest([{ path: 'a', kind: 'file', contentBase64: btoa('bc') }]))
      .not.toBe(artifactDigest([{ path: 'ab', kind: 'file', contentBase64: btoa('c') }]))
  })
})
