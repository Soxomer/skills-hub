#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const jsonPackages = [
  'package.json',
  'apps/web/package.json',
  'apps/control-plane/package.json',
  'packages/contracts/package.json',
]
const cargoPackages = ['crates/ahm-domain/Cargo.toml', 'crates/ahm-runner/Cargo.toml']

function read(filePath) {
  return fs.readFileSync(path.join(root, filePath), 'utf8')
}

function write(filePath, contents) {
  fs.writeFileSync(path.join(root, filePath), contents, 'utf8')
}

function replaceJsonProperty(filePath, property, value) {
  const original = read(filePath)
  const pattern = new RegExp(`("${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*")([^"]*)(")`)
  const match = original.match(pattern)
  if (!match) throw new Error(`Cannot find ${property} in ${filePath}`)
  const updated = original.replace(pattern, `$1${value}$3`)
  JSON.parse(updated)
  if (updated !== original) write(filePath, updated)
  return updated !== original
}

function cargoVersion(filePath) {
  const match = read(filePath).match(/^version\s*=\s*"([^"]+)"\s*$/m)
  if (!match) throw new Error(`Cannot find package version in ${filePath}`)
  return match[1]
}

function replaceCargoVersion(filePath, value) {
  const original = read(filePath)
  const updated = original.replace(/^version\s*=\s*"[^"]+"\s*$/m, `version = "${value}"`)
  if (updated === original && cargoVersion(filePath) !== value) {
    throw new Error(`Cannot update package version in ${filePath}`)
  }
  if (updated !== original) write(filePath, updated)
  return updated !== original
}

function productVersion() {
  const version = JSON.parse(read('package.json')).version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('package.json must contain a semantic version')
  }
  return version
}

function sync() {
  const version = productVersion()
  const changed = []
  for (const file of jsonPackages) {
    if (replaceJsonProperty(file, 'version', version)) changed.push(file)
  }
  for (const file of ['apps/web/package.json', 'apps/control-plane/package.json']) {
    if (replaceJsonProperty(file, '@ahm/contracts', version)) changed.push(file)
  }
  for (const file of cargoPackages) {
    if (replaceCargoVersion(file, version)) changed.push(file)
  }
  return { version, changed: [...new Set(changed)] }
}

function check() {
  const version = productVersion()
  const mismatches = []
  for (const file of jsonPackages.slice(1)) {
    const packageVersion = JSON.parse(read(file)).version
    if (packageVersion !== version) mismatches.push(`${file} version=${packageVersion}`)
  }
  for (const file of ['apps/web/package.json', 'apps/control-plane/package.json']) {
    const contractVersion = JSON.parse(read(file)).dependencies['@ahm/contracts']
    if (contractVersion !== version) mismatches.push(`${file} @ahm/contracts=${contractVersion}`)
  }
  for (const file of cargoPackages) {
    const packageVersion = cargoVersion(file)
    if (packageVersion !== version) mismatches.push(`${file} version=${packageVersion}`)
  }
  return { version, mismatches }
}

function usage() {
  console.log('Usage:')
  console.log('  node scripts/version.mjs set <x.y.z>')
  console.log('  node scripts/version.mjs sync')
  console.log('  node scripts/version.mjs check')
}

const [command, argument] = process.argv.slice(2)
if (command === 'set') {
  if (!argument) {
    usage()
    process.exit(1)
  }
  replaceJsonProperty('package.json', 'version', argument)
  const result = sync()
  console.log(`Version set to ${result.version}`)
} else if (command === 'sync') {
  const result = sync()
  console.log(
    `Synced version ${result.version}${result.changed.length ? ` (${result.changed.join(', ')})` : ''}`,
  )
} else if (command === 'check') {
  const result = check()
  if (result.mismatches.length) {
    console.error(`Version mismatch (expected ${result.version}):`)
    for (const mismatch of result.mismatches) console.error(`- ${mismatch}`)
    process.exit(1)
  }
  console.log(`Version OK (${result.version})`)
} else {
  usage()
  process.exit(1)
}
