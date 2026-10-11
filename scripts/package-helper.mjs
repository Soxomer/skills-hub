import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const [target, profile = 'release'] = process.argv.slice(2)
const names = {
  'x86_64-pc-windows-msvc': ['nsis', '.exe', 'ahm-windows-x64-setup.exe'],
  'aarch64-apple-darwin': ['dmg', '.dmg', 'ahm-macos-arm64.dmg'],
  'x86_64-apple-darwin': ['dmg', '.dmg', 'ahm-macos-x64.dmg'],
  'x86_64-unknown-linux-gnu': ['deb', '.deb', 'ahm-linux-x64.deb'],
}
if (!names[target] || !['debug', 'release'].includes(profile)) throw new Error('Unsupported helper target/profile')
const [folder, extension, name] = names[target]
const root = process.argv[4] || (profile === 'debug' ? `target/debug/bundle` : `target/${target}/release/bundle`)
const directory = join(root, folder)
const files = readdirSync(directory).filter(file => file.endsWith(extension))
if (files.length !== 1) throw new Error(`Expected one ${extension} bundle, found ${files.length}`)
mkdirSync('target/release-assets', { recursive: true })
copyFileSync(join(directory, files[0]), join('target/release-assets', name))
console.log(`Packaged ${name}`)
