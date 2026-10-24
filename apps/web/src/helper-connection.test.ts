import { describe, expect, it } from 'vitest'
import { helperConnectionLink, installerFor } from './helper-connection'

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
    for (const suffix of ['http://example.com', 'http://localhost.evil.test:8787', 'http://192.168.1.2:8787', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com?token=x', 'https://example.com#x', 'https://example.com:8443', 'https://example.com --bad', 'not-a-url']) {
      expect(helperConnectionLink(`ahm connect ${code} --server ${suffix}`)).toBeNull()
    }
    expect(helperConnectionLink('ahm connect bad --server https://example.com')).toBeNull()
  })
  it('pairs directly with this computer over loopback, including IPv6', () => {
    for (const origin of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
      const link = new URL(helperConnectionLink(`ahm connect ${code} --server ${origin}`)!)
      expect(link.searchParams.get('server')).toBe(origin)
    }
  })
  it('offers published installers without deployment-specific configuration', () => {
    for (const platform of ['windows', 'macArm', 'macIntel', 'linux'] as const) {
      expect(installerFor(platform)).toMatch(/^https:\/\/github.com\/Soxomer\/skills-hub\/releases\/download\//)
    }
  })
})
