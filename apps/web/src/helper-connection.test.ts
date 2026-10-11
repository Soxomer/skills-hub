import { describe, expect, it } from 'vitest'
import { helperConnectionLink } from './helper-connection'

describe('helper pairing handoff', () => {
  const code = 'abcdefghijklmnopqrstuv'
  it('hands over only a code and HTTPS origin, with URL encoding', () => {
    const link = new URL(helperConnectionLink(`ahm connect ${code} --server https://skill-manager.omarjetti.dev`)!)
    expect(link.protocol).toBe('ahm:')
    expect(link.hostname).toBe('connect')
    expect([...link.searchParams.keys()]).toEqual(['code', 'server'])
    expect(link.searchParams.get('code')).toBe(code)
    expect(link.searchParams.get('server')).toBe('https://skill-manager.omarjetti.dev')
  })
  it('does not hand malformed commands, credentials, paths or insecure origins to an OS handler', () => {
    for (const suffix of ['http://localhost:3001', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com?token=x', 'https://example.com#x', 'https://example.com:8443', 'https://example.com --bad', 'not-a-url']) {
      expect(helperConnectionLink(`ahm connect ${code} --server ${suffix}`)).toBeNull()
    }
    expect(helperConnectionLink('ahm connect bad --server https://example.com')).toBeNull()
  })
})
