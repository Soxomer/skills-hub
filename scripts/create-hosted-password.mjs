import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { hashPassword } from 'better-auth/crypto'

const destination = process.argv[2]
if (!destination) throw new Error('Usage: node scripts/create-hosted-password.mjs <private-output-file>')
const password = randomBytes(24).toString('base64url')
const ownerPasswordHash = await hashPassword(password)
const authSecret = randomBytes(48).toString('base64url')
writeFileSync(resolve(destination), JSON.stringify({ password, ownerPasswordHash, authSecret }, null, 2), { flag: 'wx', mode: 0o600 })
console.log('Created private credentials file. Store the password in your password manager. Set ownerPasswordHash as AHM_OWNER_PASSWORD_HASH and authSecret as BETTER_AUTH_SECRET in Railway.')
