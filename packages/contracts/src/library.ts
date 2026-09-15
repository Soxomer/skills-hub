export const LIBRARY_COMMANDS = [
  "list_directories",
  "get_tool_config",
  "set_tool_config",
  "get_tool_status",
  "get_onboarding_plan",
  "get_discovery_scan_settings",
  "set_discovery_scan_config",
  "get_git_cache_cleanup_days",
  "set_git_cache_cleanup_days",
  "clear_git_cache_now",
  "get_git_cache_ttl_secs",
  "set_git_cache_ttl_secs",
  "get_auto_update_config",
  "set_auto_update_config",
  "run_auto_update_now",
  "trigger_auto_update_task_now_cmd",
  "get_recent_projects",
  "save_recent_project",
  "get_central_repo_path",
  "set_central_repo_path",
  "list_local_skills_cmd",
  "install_local_selection",
  "list_git_skills_cmd",
  "preview_git_skill_cmd",
  "install_git_selection",
  "sync_skill_to_tool",
  "unsync_skill_from_tool",
  "set_skill_enabled",
  "update_managed_skill",
  "get_github_token",
  "set_github_token",
  "get_github_proxy_config",
  "set_github_proxy_config",
  "import_existing_skill",
  "get_managed_skills",
  "get_tags",
  "create_tag",
  "rename_tag",
  "delete_tag",
  "get_skill_tags",
  "set_skill_tags",
  "get_untagged_skill_ids",
  "delete_managed_skill",
  "get_featured_skills",
  "search_skills_online",
  "list_skill_files",
  "read_skill_file"
] as const
export type LibraryCommand = typeof LIBRARY_COMMANDS[number]
export interface LibraryRequest { command: LibraryCommand; args: Record<string, unknown>; expectedDigest: string | null }
export interface LibraryResponse { value: unknown }
export function isLibraryMutation(command: LibraryCommand): boolean {
  return !/^(get_|list_|read_|preview_|search_)/.test(command)
}

export function isLibraryRequest(value: unknown): value is LibraryRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !['command', 'args', 'expectedDigest'].includes(key))) return false
  if (!LIBRARY_COMMANDS.includes(record.command as LibraryCommand)) return false
  if (record.expectedDigest !== null && !(typeof record.expectedDigest === 'string' && /^sha256:[0-9a-f]{64}$/.test(record.expectedDigest))) return false
  if (!record.args || typeof record.args !== 'object' || Array.isArray(record.args)) return false
  const args = record.args as Record<string, unknown>
  const schema = LIBRARY_ARGUMENTS[record.command as LibraryCommand]
  if (Object.keys(args).some(key => !(key in schema))) return false
  for (const [key, type] of Object.entries(schema)) {
    const arg = args[key]
    if (type.startsWith('Option<') && arg == null) continue
    const base = type.replace(/^Option<(.+)>$/, '$1')
    if (base === 'String' && (typeof arg !== 'string' || arg.length > 8192)) return false
    if (base === 'bool' && typeof arg !== 'boolean') return false
    if (/^[iu]\d+$/.test(base) && (!Number.isSafeInteger(arg) || (base.startsWith('u') && Number(arg) < 0))) return false
    if (base === 'Vec<i64>' && (!Array.isArray(arg) || arg.length > 5000 || !arg.every(Number.isSafeInteger))) return false
    if (base === 'ToolConfigDto' && !isToolConfig(arg)) return false
    if (base === 'DiscoveryScanConfig' && (!isRecord(arg) || !hasOnly(arg, ['disabled_source_keys']) || !isKeys(arg.disabled_source_keys))) return false
    if (['basePath','sourcePath','projectPath','path','centralPath','parent'].includes(key) && (typeof arg !== 'string' || !/^folder-[0-9a-f-]{36}\/[^/\\]{1,768}$/.test(arg))) return false
    if (['subpath','filePath'].includes(key) && (typeof arg !== 'string' || /(^[\\/]|^[a-z]:|(^|[\\/])\.\.([\\/]|$))/i.test(arg))) return false
    if (['repoUrl', 'trackingUrl'].includes(key)) {
      try {
        const url = new URL(String(arg))
        if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) return false
      } catch { return false }
    }
  }
  return JSON.stringify(value).length <= 700_000
}
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const hasOnly = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))
const isKeys = (value: unknown) => Array.isArray(value) && value.length <= 200 && value.every(key => typeof key === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(key))
const relativePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/(^[\\/]|^[a-z]:|(^|[\\/])\.\.([\\/]|$))/i.test(value) && ![...value].some(char => char.charCodeAt(0) < 32)
function isToolConfig(value: unknown): boolean {
  if (!isRecord(value) || !hasOnly(value, ['disabled_builtin_tools', 'custom_tools']) || !isKeys(value.disabled_builtin_tools) || !Array.isArray(value.custom_tools) || value.custom_tools.length > 100) return false
  return value.custom_tools.every(tool => isRecord(tool)
    && hasOnly(tool, ['key', 'label', 'avatar', 'skills_dir', 'project_skills_dir', 'sync_mode', 'enabled'])
    && isKeys([tool.key]) && typeof tool.label === 'string' && tool.label.length > 0 && tool.label.length <= 200
    && (tool.avatar == null || (typeof tool.avatar === 'string' && tool.avatar.startsWith('data:image/') && tool.avatar.length <= 512 * 1024))
    && relativePath(tool.skills_dir)
    && (tool.project_skills_dir == null || (relativePath(tool.project_skills_dir) && !tool.project_skills_dir.startsWith('~')))
    && ['auto', 'symlink', 'junction', 'copy'].includes(String(tool.sync_mode)) && typeof tool.enabled === 'boolean')
}
export const LIBRARY_ARGUMENTS: Record<LibraryCommand, Record<string, string>> = {
  "list_directories": { "parent": "Option<String>" },
  "get_tool_config": {},
  "set_tool_config": {
    "config": "ToolConfigDto"
  },
  "get_tool_status": {},
  "get_onboarding_plan": {},
  "get_discovery_scan_settings": {},
  "set_discovery_scan_config": {
    "config": "DiscoveryScanConfig"
  },
  "get_git_cache_cleanup_days": {},
  "set_git_cache_cleanup_days": {
    "days": "i64"
  },
  "clear_git_cache_now": {},
  "get_git_cache_ttl_secs": {},
  "set_git_cache_ttl_secs": {
    "secs": "i64"
  },
  "get_auto_update_config": {},
  "set_auto_update_config": {
    "enabled": "bool",
    "intervalHours": "i64",
    "scheduleType": "Option<String>",
    "intervalValue": "Option<i64>",
    "intervalUnit": "Option<String>",
    "dailyTime": "Option<String>"
  },
  "run_auto_update_now": {},
  "trigger_auto_update_task_now_cmd": {},
  "get_recent_projects": {},
  "save_recent_project": {
    "projectPath": "String"
  },
  "get_central_repo_path": {},
  "set_central_repo_path": {
    "path": "String"
  },
  "list_local_skills_cmd": {
    "basePath": "String"
  },
  "install_local_selection": {
    "basePath": "String",
    "subpath": "String",
    "name": "Option<String>"
  },
  "list_git_skills_cmd": {
    "repoUrl": "String"
  },
  "preview_git_skill_cmd": {
    "repoUrl": "String",
    "skillName": "Option<String>"
  },
  "install_git_selection": {
    "trackingUrl": "Option<String>",
    "repoUrl": "String",
    "subpath": "String",
    "name": "Option<String>"
  },
  "sync_skill_to_tool": {
    "sourcePath": "String",
    "skillId": "String",
    "tool": "String",
    "name": "String",
    "overwrite": "Option<bool>",
    "overwriteIfSameContent": "Option<bool>",
    "scope": "Option<String>",
    "projectPath": "Option<String>"
  },
  "unsync_skill_from_tool": {
    "skillId": "String",
    "tool": "String",
    "scope": "Option<String>",
    "projectPath": "Option<String>"
  },
  "set_skill_enabled": {
    "skillId": "String",
    "enabled": "bool"
  },
  "update_managed_skill": {
    "skillId": "String"
  },
  "get_github_token": {},
  "set_github_token": {
    "token": "String"
  },
  "get_github_proxy_config": {},
  "set_github_proxy_config": {
    "enabled": "bool",
    "port": "u16"
  },
  "import_existing_skill": {
    "sourcePath": "String",
    "name": "Option<String>"
  },
  "get_managed_skills": {},
  "get_tags": {},
  "create_tag": {
    "name": "String"
  },
  "rename_tag": {
    "tagId": "i64",
    "name": "String"
  },
  "delete_tag": {
    "tagId": "i64"
  },
  "get_skill_tags": {
    "skillId": "String"
  },
  "set_skill_tags": {
    "skillId": "String",
    "tagIds": "Vec<i64>"
  },
  "get_untagged_skill_ids": {},
  "delete_managed_skill": {
    "skillId": "String"
  },
  "get_featured_skills": {},
  "search_skills_online": {
    "query": "String",
    "limit": "Option<u32>"
  },
  "list_skill_files": {
    "centralPath": "String"
  },
  "read_skill_file": {
    "centralPath": "String",
    "filePath": "String"
  }
}
