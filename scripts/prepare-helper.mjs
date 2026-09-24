import { copyFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const local = process.argv[2] === '--local'
const target = (local ? null : process.argv[2]) || execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)[1]
const profile = process.argv[3] || 'debug'
if (!/^[a-z0-9_-]+$/.test(target) || !['debug', 'release'].includes(profile)) throw new Error('Invalid target/profile')
const extension = target.includes('windows') ? '.exe' : ''
const source = process.argv[4] || (local ? `target/${profile}/ahm${extension}` : `target/${target}/${profile}/ahm${extension}`)
const directory = resolve('apps/helper/src-tauri/binaries')
mkdirSync(directory, { recursive: true })
copyFileSync(source, resolve(directory, `ahm-${target}${extension}`))
console.log(`Prepared helper sidecar for ${target} (${profile})`)
