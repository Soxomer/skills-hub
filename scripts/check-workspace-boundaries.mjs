import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const violations = []

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(repositoryRoot, relativePath), 'utf8'))
}

function dependencies(packageJson) {
  return {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.peerDependencies,
  }
}

function rejectDependencies(packagePath, forbiddenPrefixes) {
  const packageJson = readJson(packagePath)
  for (const dependency of Object.keys(dependencies(packageJson))) {
    if (forbiddenPrefixes.some((prefix) => dependency.startsWith(prefix))) {
      violations.push(`${packagePath} may not depend on ${dependency}`)
    }
  }
}

function sourceFiles(relativeDirectory) {
  const directory = join(repositoryRoot, relativeDirectory)
  if (!existsSync(directory)) {
    violations.push(`${relativeDirectory} does not exist`)
    return []
  }

  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      return sourceFiles(relative(repositoryRoot, path))
    }
    return ['.ts', '.tsx', '.rs'].includes(extname(path)) ? [path] : []
  })
}

function rejectSourcePatterns(relativeDirectory, patterns) {
  for (const path of sourceFiles(relativeDirectory)) {
    const source = readFileSync(path, 'utf8')
    for (const [pattern, description] of patterns) {
      if (pattern.test(source)) {
        violations.push(`${relative(repositoryRoot, path)} ${description}`)
      }
    }
  }
}

for (const packagePath of [
  'apps/web/package.json',
  'apps/control-plane/package.json',
  'packages/contracts/package.json',
]) {
  rejectDependencies(packagePath, ['@tauri-apps/'])
}

const legacyImportPatterns = [
  [/from\s+['"][^'"]*src-tauri/i, 'may not import the legacy Rust application'],
  [/from\s+['"][^'"]*\.\.\/\.\.\/src(?:\/|['"])/i, 'may not import the legacy desktop UI'],
  [/@tauri-apps\//i, 'may not import Tauri'],
]

rejectSourcePatterns('apps/web/src', legacyImportPatterns)
rejectSourcePatterns('apps/control-plane/src', legacyImportPatterns)
rejectSourcePatterns('packages/contracts/src', legacyImportPatterns)

const domainManifest = readFileSync(
  join(repositoryRoot, 'crates/ahm-domain/Cargo.toml'),
  'utf8',
)
const runnerManifest = readFileSync(
  join(repositoryRoot, 'crates/ahm-runner/Cargo.toml'),
  'utf8',
)

if (/\b(?:tauri|rusqlite)\b/i.test(domainManifest)) {
  violations.push('ahm-domain may not depend on Tauri or persistence adapters')
}
if (/\btauri\b/i.test(runnerManifest)) {
  violations.push('ahm-runner may not depend on Tauri')
}

rejectSourcePatterns('crates/ahm-domain/src', [
  [/\bstd::(?:fs|process)\b/, 'may not use filesystem or process APIs'],
  [/\btauri\b/i, 'may not use Tauri'],
])
rejectSourcePatterns('crates/ahm-runner/src', [[/\btauri\b/i, 'may not use Tauri']])

const controlPlaneMigration = readFileSync(
  join(repositoryRoot, 'apps/control-plane/migrations/0001_control_plane.sql'),
  'utf8',
)
for (const forbiddenColumn of [
  'absolute_path',
  'checkout_path',
  'filesystem_path',
  'local_path',
  'target_path',
]) {
  if (new RegExp(`\\b${forbiddenColumn}\\b`, 'i').test(controlPlaneMigration)) {
    violations.push(
      `control-plane persistence may not contain device-local column ${forbiddenColumn}`,
    )
  }
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`Boundary violation: ${violation}`)
  }
  process.exitCode = 1
} else {
  console.log('Workspace dependency boundaries are valid.')
}
