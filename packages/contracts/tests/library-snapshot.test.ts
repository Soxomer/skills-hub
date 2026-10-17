import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { isLibraryRequest, isLibrarySetupSnapshot } from '../src/index.js'

const fixture = JSON.parse(readFileSync(new URL('../fixtures/v1/result-library-snapshot.json', import.meta.url), 'utf8')).result.payload.value
it('validates portable metadata and requires approval for a snapshot', () => {
  expect(isLibrarySetupSnapshot(fixture)).toBe(true)
  expect(isLibraryRequest({ command: 'preview_setup_skill', args: { skillId: 'pdf' }, expectedDigest: null })).toBe(true)
  expect(isLibraryRequest({ command: 'snapshot_setup_skill', args: { skillId: 'pdf' }, expectedDigest: null })).toBe(false)
  expect(isLibraryRequest({ command: 'snapshot_setup_skill', args: { skillId: 'pdf' }, expectedDigest: fixture.contentDigest })).toBe(true)
  expect(isLibraryRequest({ command: 'preview_setup_skill', args: { skillId: '', path: '/private' }, expectedDigest: null })).toBe(false)
})
it.each(['../secret', '/secret', 'C:/private', 'a\\secret', '.git/config'])('rejects unsafe preview path %s', path => {
  expect(isLibrarySetupSnapshot({ ...fixture, files: [...fixture.files, { path, size: 1 }] })).toBe(false)
})
it('rejects credentials, local sources and oversized previews', () => {
  for (const portableSource of ['C:/private', 'https://user:secret@github.com/org/repo', 'https://github.com/org/repo?token=secret']) expect(isLibrarySetupSnapshot({ ...fixture, portableSource })).toBe(false)
  expect(isLibrarySetupSnapshot({ ...fixture, files: [{ path: 'SKILL.md', size: 11 * 1024 * 1024 }] })).toBe(false)
})
it('keeps snapshot paths within the artifact upload contract, including UTF-16 boundaries', () => {
  for (const path of ['a'.repeat(500), '界'.repeat(500), '😀'.repeat(250)]) {
    expect(isLibrarySetupSnapshot({ ...fixture, files: [...fixture.files, { path, size: 0 }] })).toBe(true)
    expect(isLibrarySetupSnapshot({ ...fixture, files: [...fixture.files, { path: path + 'a', size: 0 }] })).toBe(false)
  }
})
