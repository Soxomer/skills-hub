import { afterEach, expect, it, vi } from 'vitest'
import { isLibraryRequest } from '@ahm/contracts'
import { publicLibrary } from '../src/library-catalog.js'

afterEach(() => vi.unstubAllGlobals())

it('previews a selected skill without a runner and pins the install source to the displayed revision', async () => {
  const sha = 'a'.repeat(40)
  const content = '---\nname: sample\ndescription: Read before installing\n---\n# Example\n'
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ sha })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ tree: [{ path: 'skills/sample/SKILL.md', type: 'blob' }] })))
    .mockResolvedValueOnce(new Response(content))
  vi.stubGlobal('fetch', fetcher)
  const value = await publicLibrary({ command: 'preview_git_skill_cmd', args: { repoUrl: 'https://github.com/example/skills', skillName: 'sample' }, expectedDigest: null })
  expect(value).toEqual({ name: 'sample', description: 'Read before installing', content, subpath: 'skills/sample', source_url: `https://github.com/example/skills/tree/${sha}/skills/sample` })
  expect(fetcher.mock.calls[2][0]).toBe(`https://raw.githubusercontent.com/example/skills/${sha}/skills/sample/SKILL.md`)
})

it('rejects an ambiguous skill and oversized content instead of showing the wrong preview', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sha: 'a'.repeat(40) })))
  vi.stubGlobal('fetch', fetcher)
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'a'.repeat(40) })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ tree: [{ path: 'SKILL.md', type: 'blob' }, { path: 'skills/sample/SKILL.md', type: 'blob' }] })))
  await expect(publicLibrary({ command: 'preview_git_skill_cmd', args: { repoUrl: 'https://github.com/example/skills', skillName: 'sample' }, expectedDigest: null })).rejects.toThrow('PREVIEW_AMBIGUOUS')
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'a'.repeat(40) })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ tree: [{ path: 'SKILL.md', type: 'blob' }] })))
    .mockResolvedValueOnce(new Response('x'.repeat(512 * 1024 + 1)))
  await expect(publicLibrary({ command: 'preview_git_skill_cmd', args: { repoUrl: 'https://github.com/example/skills' }, expectedDigest: null })).rejects.toThrow('PREVIEW_TOO_LARGE')
})

it('rejects local and credential-bearing preview URLs without fetching them', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  for (const repoUrl of ['file:///home/skills', 'https://token@github.com/example/skills', 'http://127.0.0.1/admin']) {
    await expect(publicLibrary({ command: 'preview_git_skill_cmd', args: { repoUrl }, expectedDigest: null })).rejects.toThrow('PREVIEW_UNSUPPORTED_SOURCE')
  }
  expect(fetcher).not.toHaveBeenCalled()
})

it('validates portable file arguments and nested tool settings at the HTTP boundary', () => {
  const handle = 'folder-01234567-0123-0123-0123-0123456789ab/sample'
  expect(isLibraryRequest({ command: 'read_skill_file', args: { centralPath: handle, filePath: 'SKILL.md' }, expectedDigest: null })).toBe(true)
  expect(isLibraryRequest({ command: 'read_skill_file', args: { centralPath: handle, filePath: '../private' }, expectedDigest: null })).toBe(false)
  const tool = { key: 'custom', label: 'Custom', skills_dir: '~/.custom/skills', project_skills_dir: '.custom/skills', sync_mode: 'copy', enabled: true }
  const request = (override: Record<string, unknown>) => ({ command: 'set_tool_config', args: { config: { disabled_builtin_tools: [], custom_tools: [{ ...tool, ...override }] } }, expectedDigest: null })
  expect(isLibraryRequest(request({}))).toBe(true)
  for (const override of [{ skills_dir: 'C:\\private' }, { project_skills_dir: '../outside' }, { token: 'secret' }]) expect(isLibraryRequest(request(override))).toBe(false)
})
