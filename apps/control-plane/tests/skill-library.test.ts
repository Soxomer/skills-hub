import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { isSkillLibrary } from '../src/skill-library.js'

const fixture: unknown[] = JSON.parse(readFileSync(new URL('../../../packages/contracts/fixtures/v1/transport/managed-skill-library.json', import.meta.url), 'utf8'))
it('accepts the shared portable inventory fixture and an empty library', () => {
  expect(isSkillLibrary(fixture)).toBe(true)
  expect(isSkillLibrary([])).toBe(true)
})
it('rejects path-bearing fields, malformed targets, duplicates, and oversized inventories', () => {
  expect(isSkillLibrary([{ ...fixture[0] as object, centralPath: '/private/library' }])).toBe(false)
  expect(isSkillLibrary([{ ...fixture[0] as object, targets: [{ tool: 'codex', scope: 'global', targetPath: '/private' }] }])).toBe(false)
  expect(isSkillLibrary([fixture[0], fixture[0]])).toBe(false)
  expect(isSkillLibrary([{ ...fixture[0] as object, name: 'a'.repeat(513) }])).toBe(false)
  expect(isSkillLibrary(null)).toBe(false)
})
