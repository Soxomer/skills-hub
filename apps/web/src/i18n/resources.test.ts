import { describe, expect, it } from 'vitest'

import { resources } from './resources'

describe('web translations', () => {
  it('ships one English product resource without CJK copy', () => {
    expect(Object.keys(resources)).toEqual(['en'])
    expect(JSON.stringify(resources)).not.toMatch(/[\u3400-\u9fff]/u)
  })
})
