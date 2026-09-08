import { readFileSync } from 'node:fs'
import type { ArtifactBundle } from '@ahm/contracts'
import { describe, expect, it } from 'vitest'
import { artifactDigest } from '../src/artifact-digest.js'
import { RunnerTransportService } from '../src/runner-transport.js'
import { InMemoryRunnerTransportRepository } from '../src/runner-transport-memory.js'

class ArtifactRepository extends InMemoryRunnerTransportRepository {
  override async authenticateRunner() {
    return { organizationId: 'org_01', deviceId: 'device_01', status: 'active' as const }
  }
}

const fixture = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/artifacts/canonical-v1.json', import.meta.url), 'utf8')) as ArtifactBundle

describe('artifact publication boundary', () => {
  it('rejects corrupted bytes without occupying the digest, then accepts the correct bundle', async () => {
    const service = new RunnerTransportService(new ArtifactRepository(), { serverUrl: 'http://localhost' })
    const wrong = structuredClone(fixture)
    wrong.entries[0]!.contentBase64 = btoa('wrong')
    await expect(service.storeArtifact('credential', wrong)).rejects.toMatchObject({ statusCode: 400 })
    await expect(service.loadArtifact('credential', fixture.contentDigest)).rejects.toMatchObject({ statusCode: 404 })
    await service.storeArtifact('credential', fixture)
    expect(await service.loadArtifact('credential', fixture.contentDigest)).toEqual(fixture)
  })

  it.each(['../escape', 'C:/drive', 'nested\\file', '/root', 'a\u0000b', '.git/config'])('rejects nonportable path %s', async (path) => {
    const service = new RunnerTransportService(new ArtifactRepository(), { serverUrl: 'http://localhost' })
    const entries = [{ path, kind: 'file' as const, contentBase64: btoa('bytes') }]
    await expect(service.storeArtifact('credential', { contentDigest: artifactDigest(entries), entries }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects undeclared parent directories and duplicate paths', async () => {
    const service = new RunnerTransportService(new ArtifactRepository(), { serverUrl: 'http://localhost' })
    for (const entries of [
      [{ path: 'nested/file', kind: 'file' as const, contentBase64: btoa('bytes') }],
      [fixture.entries[2]!, fixture.entries[2]!],
    ]) {
      await expect(service.storeArtifact('credential', { contentDigest: artifactDigest(entries), entries }))
        .rejects.toMatchObject({ statusCode: 400 })
    }
  })
})
