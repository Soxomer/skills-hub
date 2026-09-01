import { describe, expect, it } from 'vitest'

import { resources } from './resources'

function leafKeys(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return typeof child === 'object' && child !== null ? leafKeys(child, path) : [path]
  })
}

describe('web translations', () => {
  it('keeps English and Chinese resource keys in sync', () => {
    expect(leafKeys(resources.zh.translation).sort()).toEqual(
      leafKeys(resources.en.translation).sort(),
    )
  })
})
