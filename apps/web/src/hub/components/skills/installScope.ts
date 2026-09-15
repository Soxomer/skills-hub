import type { SetStateAction } from 'react'
import type { ToolOption } from './types'

export type InstallScope = 'global' | 'project'

export type InstallSyncJob =
  | { toolId: string; scope: 'global' }
  | { toolId: string; scope: 'project'; projectPath: string }

export const normalizeProjectPaths = (projects: string[]): string[] =>
  Array.from(
    new Set(projects.map((project) => project.trim()).filter(Boolean)),
  )

export const getAvailableRecentProjects = (
  recentProjects: string[],
  selectedProjects: string[],
): string[] => {
  const selected = new Set(normalizeProjectPaths(selectedProjects))

  return normalizeProjectPaths(recentProjects).filter(
    (project) => !selected.has(project),
  )
}

export const getAddedProjectPaths = (
  previousProjects: string[],
  nextProjects: string[],
): string[] => {
  const previous = new Set(normalizeProjectPaths(previousProjects))

  return normalizeProjectPaths(nextProjects).filter(
    (project) => !previous.has(project),
  )
}

export const resolveProjectPathsUpdate = (
  currentProjects: string[],
  update: SetStateAction<string[]>,
): string[] =>
  normalizeProjectPaths(
    typeof update === 'function' ? update(currentProjects) : update,
  )

export const isLatestSaveBatch = (
  batchSequence: number,
  latestSequence: number,
): boolean => batchSequence === latestSequence

export const isToolUnsupportedForScope = (
  tool: ToolOption,
  scope: InstallScope,
): boolean =>
  scope === 'project' && tool.supports_project_scope === false

export const getUnsupportedToolsForScope = (
  tools: ToolOption[],
  scope: InstallScope,
): ToolOption[] =>
  tools.filter((tool) => isToolUnsupportedForScope(tool, scope))

export const filterTargetsForScope = (
  targets: Record<string, boolean>,
  tools: ToolOption[],
  scope: InstallScope,
): Record<string, boolean> => {
  if (scope === 'global') return { ...targets }

  const supportsProject = new Map(
    tools.map((tool) => [tool.id, tool.supports_project_scope ?? true]),
  )

  return Object.fromEntries(
    Object.entries(targets).map(([toolId, selected]) => [
      toolId,
      selected && supportsProject.get(toolId) === true,
    ]),
  )
}

export const normalizeProjectSharedTargets = (
  targets: Record<string, boolean>,
  tools: ToolOption[],
  sharedProjectToolIdsByToolId: Record<string, string[]>,
): Record<string, boolean> => {
  const next = { ...targets }
  const supportsProject = new Map(
    tools.map((tool) => [tool.id, tool.supports_project_scope ?? true]),
  )
  const processed = new Set<string>()

  for (const tool of tools) {
    if (processed.has(tool.id)) continue
    const shared = sharedProjectToolIdsByToolId[tool.id] ?? [tool.id]
    const supported = shared.filter(
      (toolId) => supportsProject.get(toolId) === true,
    )
    const selected = supported.some((toolId) => targets[toolId])

    for (const toolId of shared) {
      next[toolId] = supportsProject.get(toolId) === true && selected
      processed.add(toolId)
    }
  }

  return next
}

export const selectInstallToolIds = (
  tools: ToolOption[],
  syncTargets: Record<string, boolean>,
  installedToolIds: string[],
  scope: InstallScope,
  uniqueGlobalToolIds: (toolIds: string[]) => string[],
  uniqueProjectToolIds: (toolIds: string[]) => string[],
): string[] => {
  const installed = new Set(installedToolIds)
  const selectedToolIds = tools
    .filter(
      (tool) =>
        syncTargets[tool.id] &&
        installed.has(tool.id) &&
        !isToolUnsupportedForScope(tool, scope),
    )
    .map((tool) => tool.id)

  return scope === 'global'
    ? uniqueGlobalToolIds(selectedToolIds)
    : uniqueProjectToolIds(selectedToolIds)
}

export const buildInstallSyncJobs = (
  toolIds: string[],
  scope: InstallScope,
  projects: string[],
): InstallSyncJob[] => {
  if (scope === 'global') {
    return toolIds.map((toolId) => ({ toolId, scope: 'global' }))
  }

  const projectPaths = normalizeProjectPaths(projects)

  return toolIds.flatMap((toolId) =>
    projectPaths.map((projectPath) => ({
      toolId,
      scope: 'project' as const,
      projectPath,
    })),
  )
}
