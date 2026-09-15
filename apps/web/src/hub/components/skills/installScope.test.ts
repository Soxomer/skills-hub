import { describe, expect, it } from 'vitest'
import {
  buildInstallSyncJobs,
  filterTargetsForScope,
  getAddedProjectPaths,
  getAvailableRecentProjects,
  getUnsupportedToolsForScope,
  isLatestSaveBatch,
  isToolUnsupportedForScope,
  normalizeProjectSharedTargets,
  normalizeProjectPaths,
  resolveProjectPathsUpdate,
  selectInstallToolIds,
} from './installScope'
import type { ToolOption } from './types'

const tools: ToolOption[] = [
  { id: 'cursor', label: 'Cursor', supports_project_scope: true },
  { id: 'hermes', label: 'Hermes Agent', supports_project_scope: false },
  { id: 'codex', label: 'Codex' },
]

describe('normalizeProjectPaths', () => {
  it('removes empty and duplicate project paths', () => {
    expect(
      normalizeProjectPaths([
        '/repo/a',
        '',
        '   ',
        '/repo/a',
        ' /repo/b ',
      ]),
    ).toEqual(['/repo/a', '/repo/b'])
  })
})

describe('getAvailableRecentProjects', () => {
  it('returns normalized recent projects that are not already selected', () => {
    expect(
      getAvailableRecentProjects(
        ['/repo/a', ' /repo/b ', '/repo/a', '', '/repo/c'],
        ['/repo/b', ' /repo/d '],
      ),
    ).toEqual(['/repo/a', '/repo/c'])
  })
})

describe('getAddedProjectPaths', () => {
  it('returns normalized paths newly added to the selection', () => {
    expect(
      getAddedProjectPaths(
        ['/repo/a', ' /repo/b '],
        ['/repo/a', '/repo/b', ' /repo/c ', '/repo/c', ''],
      ),
    ).toEqual(['/repo/c'])
  })
})

describe('resolveProjectPathsUpdate', () => {
  it('applies functional updates to the latest project paths', () => {
    expect(
      resolveProjectPathsUpdate(
        ['/repo/a'],
        (current) => [...current, '/repo/b'],
      ),
    ).toEqual(['/repo/a', '/repo/b'])
  })
})

describe('isLatestSaveBatch', () => {
  it('only accepts the current save batch', () => {
    expect(isLatestSaveBatch(2, 2)).toBe(true)
    expect(isLatestSaveBatch(1, 2)).toBe(false)
  })
})

describe('filterTargetsForScope', () => {
  it('keeps global targets unchanged', () => {
    expect(
      filterTargetsForScope(
        { cursor: true, hermes: true, codex: true },
        tools,
        'global',
      ),
    ).toEqual({ cursor: true, hermes: true, codex: true })
  })

  it('unselects tools that do not support project scope', () => {
    expect(
      filterTargetsForScope(
        { cursor: true, hermes: true, codex: true },
        tools,
        'project',
      ),
    ).toEqual({ cursor: true, hermes: false, codex: true })
  })
})

describe('normalizeProjectSharedTargets', () => {
  it('selects every supported tool when any tool in a project directory group is selected', () => {
    expect(
      normalizeProjectSharedTargets(
        { cursor: false, codex: true, hermes: true },
        tools,
        {
          cursor: ['cursor', 'codex', 'hermes'],
          codex: ['cursor', 'codex', 'hermes'],
          hermes: ['cursor', 'codex', 'hermes'],
        },
      ),
    ).toEqual({ cursor: true, codex: true, hermes: false })
  })

  it('keeps a project directory group unselected when none of its supported tools is selected', () => {
    expect(
      normalizeProjectSharedTargets(
        { cursor: false, codex: false, hermes: true },
        tools,
        {
          cursor: ['cursor', 'codex', 'hermes'],
          codex: ['cursor', 'codex', 'hermes'],
          hermes: ['cursor', 'codex', 'hermes'],
        },
      ),
    ).toEqual({ cursor: false, codex: false, hermes: false })
  })
})

describe('isToolUnsupportedForScope', () => {
  it('only marks explicitly unsupported tools in project scope', () => {
    expect(isToolUnsupportedForScope(tools[0], 'project')).toBe(false)
    expect(isToolUnsupportedForScope(tools[1], 'project')).toBe(true)
    expect(isToolUnsupportedForScope(tools[2], 'project')).toBe(false)
    expect(isToolUnsupportedForScope(tools[1], 'global')).toBe(false)
  })
})

describe('getUnsupportedToolsForScope', () => {
  it('returns unsupported tools only in project scope', () => {
    expect(getUnsupportedToolsForScope(tools, 'project')).toEqual([tools[1]])
    expect(getUnsupportedToolsForScope(tools, 'global')).toEqual([])
  })
})

describe('buildInstallSyncJobs', () => {
  it('creates one global job per tool', () => {
    expect(buildInstallSyncJobs(['cursor', 'hermes'], 'global', [])).toEqual([
      { toolId: 'cursor', scope: 'global' },
      { toolId: 'hermes', scope: 'global' },
    ])
  })

  it('creates one project job per tool and unique project', () => {
    expect(
      buildInstallSyncJobs(
        ['cursor', 'codex'],
        'project',
        ['/repo/a', '/repo/a', ' /repo/b '],
      ),
    ).toEqual([
      { toolId: 'cursor', scope: 'project', projectPath: '/repo/a' },
      { toolId: 'cursor', scope: 'project', projectPath: '/repo/b' },
      { toolId: 'codex', scope: 'project', projectPath: '/repo/a' },
      { toolId: 'codex', scope: 'project', projectPath: '/repo/b' },
    ])
  })

  it('returns no project jobs when no projects are selected', () => {
    expect(buildInstallSyncJobs(['cursor'], 'project', ['', '   '])).toEqual([])
  })
})

describe('selectInstallToolIds', () => {
  it('filters unsupported tools and deduplicates project directory groups', () => {
    const uniqueGlobalFn = (toolIds: string[]) => [toolIds[0]]
    const uniqueProjectFn = (toolIds: string[]) => [toolIds[1]]

    expect(
      selectInstallToolIds(
        tools,
        { cursor: true, hermes: true, codex: true },
        ['cursor', 'hermes', 'codex'],
        'project',
        uniqueGlobalFn,
        uniqueProjectFn,
      ),
    ).toEqual(['codex'])
  })

  it('deduplicates selected installed tools by global skills directory', () => {
    const uniqueGlobalFn = (toolIds: string[]) => [toolIds[0], toolIds[2]]

    expect(
      selectInstallToolIds(
        tools,
        { cursor: true, hermes: true, codex: true },
        ['cursor', 'hermes', 'codex'],
        'global',
        uniqueGlobalFn,
        (toolIds) => toolIds,
      ),
    ).toEqual(['cursor', 'codex'])
  })

  it('excludes selected tools that are not installed', () => {
    expect(
      selectInstallToolIds(
        tools,
        { cursor: true, hermes: true, codex: true },
        ['cursor'],
        'project',
        (toolIds) => toolIds,
        (toolIds) => toolIds,
      ),
    ).toEqual(['cursor'])
  })
})
