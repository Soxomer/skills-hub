import { describe, expect, it } from 'vitest'

import { resources } from './resources'

describe('web translations', () => {
  it('ships one English product resource without CJK copy', () => {
    expect(Object.keys(resources)).toEqual(['en'])
    expect(JSON.stringify(resources)).not.toMatch(/[\u3400-\u9fff]/u)
  })

  it('keeps the Setup composer source identity translatable', () => {
    const composer = resources.en.translation.switchFlow.composer
    expect(composer.itemMeta).toContain('{{kind}}')
    expect(composer.itemMeta).toContain('{{source}} v{{revision}}')
    expect(composer.sourceLabel).toBe('Source')
    expect(composer.localSource).toBe('Captured local content')
    expect(composer.digestLabel).toBe('Digest')
    expect(composer.artifactKind).toEqual({
      skill: 'Standalone skill',
      pluginSkill: 'Plugin skill',
      localContent: 'Local content',
    })
  })
})
