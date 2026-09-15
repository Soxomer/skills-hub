import type { LibraryRequest } from '@ahm/contracts'
import { RunnerTransportError } from './runner-transport.js'
import { bundledSkills } from './library-catalog-data.js'

async function boundedText(url: string, maxBytes: number): Promise<string> {
  const response = await fetch(url, { redirect: 'error', headers: { 'User-Agent': 'Agent-Harness-Manager', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new RunnerTransportError(502, 'The skill source is unavailable. Try again shortly.')
  const reader = response.body?.getReader()
  if (!reader) throw new RunnerTransportError(502, 'The skill source returned no content.')
  const parts: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > maxBytes) throw new RunnerTransportError(413, 'PREVIEW_TOO_LARGE|The skill exceeds the preview limit.')
      parts.push(value)
    }
  } finally { await reader.cancel() }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))
}

function safePart(value: string): boolean { return /^[a-zA-Z0-9_.-]+$/.test(value) && value !== '.' && value !== '..' }

export async function publicLibrary(request: LibraryRequest): Promise<unknown> {
  if (request.command === 'get_featured_skills') return bundledSkills
  if (request.command === 'search_skills_online') {
    const query = String(request.args.query ?? '').trim()
    const limit = Math.min(50, Math.max(1, Number(request.args.limit ?? 20)))
    const data = JSON.parse(await boundedText(`https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=${limit}`, 1_000_000)) as { skills?: { name: string; installs: number; source: string }[] }
    return (data.skills ?? []).filter(skill => typeof skill.source === 'string' && skill.source.split('/').length === 2 && skill.source.split('/').every(safePart)).slice(0, limit).map(skill => ({ ...skill, source_url: `https://github.com/${skill.source}` }))
  }
  if (request.command !== 'preview_git_skill_cmd') throw new RunnerTransportError(400, 'Unsupported catalogue action')
  let url: URL
  try { url = new URL(String(request.args.repoUrl)) } catch { throw new RunnerTransportError(400, 'PREVIEW_UNSUPPORTED_SOURCE|Use a GitHub repository URL.') }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) throw new RunnerTransportError(400, 'PREVIEW_UNSUPPORTED_SOURCE|Use a GitHub repository URL.')
  const [owner, rawRepo, kind, branch, ...segments] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const repo = rawRepo?.replace(/\.git$/, '')
  if (!owner || !repo || !safePart(owner) || !safePart(repo) || (kind && !['tree','blob'].includes(kind)) || (branch && !safePart(branch)) || !segments.every(safePart)) throw new RunnerTransportError(400, 'Invalid GitHub source')
  const commit = JSON.parse(await boundedText(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch ?? 'HEAD')}`, 2_000_000)) as { sha?: string }
  if (!commit.sha || !/^[0-9a-f]{40}$/.test(commit.sha)) throw new RunnerTransportError(502, 'The source revision is unavailable.')
  const tree = JSON.parse(await boundedText(`https://api.github.com/repos/${owner}/${repo}/git/trees/${commit.sha}?recursive=1`, 12_000_000)) as { tree?: { path: string; type: string }[]; truncated?: boolean }
  const requested = typeof request.args.skillName === 'string' && safePart(request.args.skillName) ? request.args.skillName : null
  const subpath = segments.join('/').replace(/\/SKILL\.md$/, '')
  const candidates = subpath ? [`${subpath}/SKILL.md`] : ['SKILL.md', ...(requested ? [requested, `skills/${requested}`, `.claude/skills/${requested}`, `.codex/skills/${requested}`, `.opencode/skills/${requested}`, `.github/skills/${requested}`, `agent-skills/${requested}`, `.agents/skills/${requested}`].map(path => `${path}/SKILL.md`) : [])]
  const matches = (tree.tree ?? []).filter(entry => entry.type === 'blob' && candidates.includes(entry.path))
  if (matches.length === 0) throw new RunnerTransportError(404, 'PREVIEW_NOT_FOUND|No matching SKILL.md was found.')
  if (matches.length > 1) throw new RunnerTransportError(409, 'PREVIEW_AMBIGUOUS|Open the exact skill directory to preview it.')
  const path = matches[0].path
  const content = await boundedText(`https://raw.githubusercontent.com/${owner}/${repo}/${commit.sha}/${path.split('/').map(encodeURIComponent).join('/')}`, 512 * 1024)
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1] ?? ''
  const field = (key: string) => new RegExp(`^${key}:\\s*["']?([^\\r\\n"']+)`, 'm').exec(frontmatter)?.[1]?.trim()
  const selectedPath = path === 'SKILL.md' ? '.' : path.slice(0, -'/SKILL.md'.length)
  return { name: field('name') ?? requested ?? repo, description: field('description') ?? null, content, subpath: selectedPath, source_url: `https://github.com/${owner}/${repo}/tree/${commit.sha}${selectedPath === '.' ? '' : '/' + selectedPath}` }
}
