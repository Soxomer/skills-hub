import { expect, it } from 'vitest'
import type { AddLibrarySkillRequest, LibrarySetupSnapshot } from '@ahm/contracts'
import { InMemorySetupRepository } from '../src/setups-memory.js'
import { SetupService } from '../src/setups.js'

const actor = { organizationId: 'org', userId: 'user' }
const digest = 'sha256:' + 'a'.repeat(64)
const snapshot: LibrarySetupSnapshot = { artifactId: 'library-aaa', name: 'review', contentDigest: digest, portableSource: null, supportedTools: ['codex', 'claude_code'], files: [{ path: 'SKILL.md', size: 10 }] }
function fixture() {
  const repository = new InMemorySetupRepository(); let id = 0
  repository.seedLibrarySnapshot('org', 'snapshot-one', snapshot)
  return { repository, service: new SetupService(repository, { randomId: () => `${++id}` }) }
}
const request: AddLibrarySkillRequest = { snapshotJobId: 'snapshot-one', contentDigest: digest, destination: { name: 'Review setup' }, targets: [{ toolId: 'codex', targetName: 'review' }] }

it('creates a Setup without a project, replays publication and exposes immutable content identity', async () => {
  const { service } = fixture()
  const first = await service.addLibrarySkill(actor, request)
  expect(first).toMatchObject({ revisionNumber: 1, itemCount: 1 })
  expect(await service.addLibrarySkill(actor, request)).toEqual(first)
  const detail = await service.setupDetail(actor, first.setupId)
  expect(detail.projects).toEqual([])
  expect(detail.revisions).toHaveLength(1)
  expect(detail.revisions[0]!.items[0]).toMatchObject({ artifactId: snapshot.artifactId, contentDigest: digest, toolId: 'codex', targetName: 'review' })
  await expect(service.addLibrarySkill(actor, { ...request, targets: [{ toolId: 'claude_code', targetName: 'review' }] })).rejects.toMatchObject({ code: 'setupPublicationConflict' })
})
it('adds to the latest version while keeping previous versions and unrelated items', async () => {
  const { service, repository } = fixture()
  const first = await service.addLibrarySkill(actor, request)
  repository.seedLibrarySnapshot('org', 'snapshot-two', { ...snapshot, contentDigest: 'sha256:'+'b'.repeat(64), artifactId: 'library-bbb' })
  const next: AddLibrarySkillRequest = { snapshotJobId: 'snapshot-two', contentDigest: 'sha256:'+'b'.repeat(64), destination: { setupId: first.setupId, expectedRevisionNumber: 1 }, targets: [{ toolId: 'claude_code', targetName: 'other' }] }
  const second = await service.addLibrarySkill(actor, next)
  expect(second).toMatchObject({ revisionNumber: 2, itemCount: 2 })
  const detail = await service.setupDetail(actor, first.setupId)
  expect(detail.revisions.map(r => r.itemCount)).toEqual([2, 1])
  expect(detail.initialSetupRevisionId).toBe(first.setupRevisionId)
  repository.seedLibrarySnapshot('org', 'snapshot-three', snapshot)
  await expect(service.addLibrarySkill(actor, { ...next, snapshotJobId: 'snapshot-three', contentDigest: digest })).rejects.toMatchObject({ code: 'setupRevisionConflict' })
  await expect(service.addLibrarySkill(actor, { ...request, snapshotJobId: 'snapshot-three', destination: { setupId: first.setupId, expectedRevisionNumber: 2 } })).rejects.toMatchObject({ code: 'setupTargetConflict' })
  expect((await service.setupDetail(actor, first.setupId)).revisions).toHaveLength(2)
})
it('rejects foreign snapshots, changed digests, unsafe targets, duplicate targets and unsupported tools', async () => {
  const { service } = fixture()
  await expect(service.addLibrarySkill({ ...actor, organizationId: 'other' }, request)).rejects.toMatchObject({ code: 'setupSnapshotUnavailable' })
  await expect(service.addLibrarySkill(actor, { ...request, contentDigest: 'sha256:'+'b'.repeat(64) })).rejects.toMatchObject({ code: 'setupSnapshotUnavailable' })
  await expect(service.addLibrarySkill(actor, { ...request, targets: [{ toolId: 'unsupported', targetName: 'review' }] })).rejects.toMatchObject({ code: 'setupSnapshotUnavailable' })
  for (const targets of [[{ toolId: 'codex', targetName: '../bad' }], [...request.targets, ...request.targets]]) await expect(service.addLibrarySkill(actor, { ...request, targets })).rejects.toMatchObject({ code: 'invalidSetupItems' })
})
