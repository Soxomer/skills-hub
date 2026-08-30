import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'

import {
  PROTOCOL_VERSION,
  UnsupportedProtocolVersionError,
  assertSupportedProtocolVersion,
  negotiateProtocolVersion,
  type CapabilityEnvelope,
  type JobEnvelope,
  type ResultEnvelope,
} from '../src/index.js'

type ProtocolEnvelope = CapabilityEnvelope | JobEnvelope | ResultEnvelope

const schemaPath = fileURLToPath(
  new URL('../schemas/v1/protocol.schema.json', import.meta.url),
)
const fixtureDirectory = fileURLToPath(new URL('../fixtures/v1/', import.meta.url))
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object
const ajv = new Ajv2020({ allErrors: true, strict: true })
const validate = ajv.compile<ProtocolEnvelope>(schema)

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(`${fixtureDirectory}/${name}`, 'utf8'))
}

describe('protocol v1 golden fixtures', () => {
  const fixtureNames = readdirSync(fixtureDirectory)
    .filter((name) => name.endsWith('.json'))
    .sort()

  it.each(fixtureNames)('validates and round-trips %s', (fixtureName) => {
    const fixture = loadFixture(fixtureName)
    const isValid = validate(fixture)

    expect(isValid, JSON.stringify(validate.errors)).toBe(true)
    if (!isValid) {
      throw new Error(`Invalid golden fixture: ${fixtureName}`)
    }
    const typedEnvelope: ProtocolEnvelope = fixture
    expect(JSON.parse(JSON.stringify(typedEnvelope))).toEqual(fixture)
  })

  it('rejects unknown fields', () => {
    const fixture = loadFixture('job-scan.json') as Record<string, unknown>
    fixture.command = 'rm -rf project'

    expect(validate(fixture)).toBe(false)
  })

  it('rejects unsupported protocol versions', () => {
    const fixture = loadFixture('capabilities.json') as Record<string, unknown>
    fixture.protocolVersion = '2.0'

    expect(validate(fixture)).toBe(false)
    expect(() => assertSupportedProtocolVersion('2.0')).toThrow(
      UnsupportedProtocolVersionError,
    )
  })

  it('negotiates only explicitly supported versions', () => {
    expect(negotiateProtocolVersion(['2.0', PROTOCOL_VERSION])).toBe(
      PROTOCOL_VERSION,
    )
    expect(negotiateProtocolVersion(['2.0'])).toBeNull()
  })

  it('rejects absolute and traversing plan destinations', () => {
    const windowsPathFixture = loadFixture('result-plan.json') as {
      result: { payload: { plan: { actions: Array<{ destination: { projectRelativePath: string } }> } } }
    }
    windowsPathFixture.result.payload.plan.actions[0].destination.projectRelativePath =
      'C:\\project\\.agents\\skills\\pdf'
    expect(validate(windowsPathFixture)).toBe(false)

    const traversalFixture = loadFixture('result-plan.json') as typeof windowsPathFixture
    traversalFixture.result.payload.plan.actions[0].destination.projectRelativePath =
      '../outside'
    expect(validate(traversalFixture)).toBe(false)
  })
})
