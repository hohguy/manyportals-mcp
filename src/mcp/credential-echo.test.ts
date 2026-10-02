import { describe, it, expect } from 'vitest'
import { createHash, createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeConfigProvider, loadConfig } from '../config/index.js'
import { REDACTED_IN_TEXT } from '../config/credential-shape.js'
import { PortalRegistry } from '../portals/index.js'
import { FakeHubSpotClient } from '../hubspot/fake.js'
import { PortalIdIndex } from '../safety/index.js'
import { FileAuditLog, InMemoryAuditLog } from '../audit/index.js'
import { JsonlDir } from '../store/jsonl-dir.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { PlanService } from '../plans/index.js'
import { ReadService } from '../reads/index.js'
import { createMcpServer } from './server.js'

/**
 * PROPERTY, not twelve patches (#112 7a).
 *
 * Caller-supplied text reached tool results and the durable trail verbatim from at
 * least twelve places: an `objectType` that is not allow-listed, an unfound
 * `objectId`, a pipeline or stage value, a blocked property NAME, an unknown
 * `planId`, and the success path's `inspect` event, which stores each target's type
 * and id as given. A model that has been fed a token by a prompt injection, or an
 * operator who pastes one into the wrong argument, writes it into an append-only log
 * that `src/audit/index.ts` states has deliberately no mutate or delete API. There is
 * no in-product way to take it back out.
 *
 * Patching the twelve sites is the same mistake at greater volume, so this drives a
 * credential-shaped string through EVERY registered tool, generically, from the tool
 * list the server itself advertises. A tool added tomorrow is covered on the day it
 * is registered, which is the only version of this that cannot rot.
 */
const PAT = ['pat', 'na1', '0f2e4c6a', '1b3d', '5e7f', '9a0b', 'c1d2e3f4a5b6'].join('-')

function build() {
  const config = loadConfig(
    new FakeConfigProvider({
      portals: {
        PORTAL_A: {
          tokenEnv: 'A',
          expectedHubId: 111,
          label: 'Portal A',
          allowWrite: true,
          allowedObjects: ['notes', 'deals'],
          allowedOperations: ['create', 'update'],
          applyAllowedObjects: ['notes'],
          blockedProperties: ['*ssn*'],
        },
      },
      writeMode: 'propose',
    }),
  )
  const registry = new PortalRegistry(config)
  const client = new FakeHubSpotClient()
  const idIndex = new PortalIdIndex()
  const audit = new InMemoryAuditLog()
  const plans = new PlanService({
    registry,
    client,
    idIndex,
    audit,
    resolveToken: (k) => `tok-${k}`,
    writeMode: 'propose',
  })
  const reads = new ReadService({ registry, client, idIndex, resolveToken: (k) => `tok-${k}` })
  const server = createMcpServer({ registry, plans, reads, audit })
  return { server, audit, plans, registry }
}

type JsonSchema = {
  type?: string
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  enum?: unknown[]
  required?: string[]
}

/**
 * Fill every string-typed leaf of a tool's input schema with `fill`, except the keys
 * in `pin`, which take their given value. Enums take their first member, because a
 * credential is never a legal enum value and the point is to reach the code past
 * validation, not to fail at it.
 */
function argsFor(schema: JsonSchema, fill: string, pin: Record<string, unknown>): unknown {
  const walk = (s: JsonSchema, key?: string): unknown => {
    if (key !== undefined && key in pin) return pin[key]
    if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0]
    switch (s.type) {
      case 'string':
        return fill
      case 'number':
      case 'integer':
        return 1
      case 'boolean':
        return false
      case 'array':
        return [walk(s.items ?? { type: 'string' }, key)]
      case 'object': {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(s.properties ?? {})) out[k] = walk(v, k)
        return out
      }
      default:
        return fill
    }
  }
  return walk({ ...schema, type: schema.type ?? 'object' })
}

async function connect(server: ReturnType<typeof build>['server']): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'credential-echo', version: '0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

describe('no credential-shaped input is echoed back or written down (#112 7a)', () => {
  it('through every registered tool, in three passes', async () => {
    const { server, audit, plans } = build()
    const client = await connect(server)
    const { tools } = await client.listTools()
    expect(tools.length).toBeGreaterThan(10) // the property is worthless over an empty list

    // A real plan, so the passes that pin a valid planId reach past `require(planId)`
    // into the operation-shaped refusals, which is where most of the twelve live.
    const plan = plans.draft({
      portalKey: 'PORTAL_A',
      operation: { kind: 'create', objectType: 'notes', properties: { hs_note_body: 'hi' } },
    })

    const passes: Array<[string, Record<string, unknown>]> = [
      ['everything is the credential', {}],
      ['a valid portal, the credential everywhere else', { portalKey: 'PORTAL_A' }],
      [
        'a valid portal and plan, the credential everywhere else',
        { portalKey: 'PORTAL_A', planId: plan.id, targetPortal: 'PORTAL_A' },
      ],
    ]

    const transcript: string[] = []
    for (const [label, pin] of passes) {
      for (const tool of tools) {
        const args = argsFor(tool.inputSchema as JsonSchema, PAT, pin)
        try {
          const r = await client.callTool({ name: tool.name, arguments: args as never })
          transcript.push(`${label}/${tool.name}: ${JSON.stringify(r)}`)
        } catch (e) {
          // A protocol-level rejection is still output the caller sees.
          transcript.push(`${label}/${tool.name}: ${String(e)}`)
        }
      }
    }

    const offenders = transcript.filter((t) => t.includes(PAT))
    expect(
      offenders.map((o) => o.slice(0, o.indexOf(':'))),
      'these tool results echoed the credential back',
    ).toEqual([])

    const trail = audit.all().map((e) => JSON.stringify(e))
    const written = trail.filter((line) => line.includes(PAT))
    expect(written, 'these audit lines recorded the credential permanently').toEqual([])
  }, 60_000)
})

describe('a refusal always leaves a record (#112 7b)', () => {
  it.each([
    ['validate_plan', { planId: 'plan_missing' }],
    ['inspect_plan_target', { planId: 'plan_missing' }],
    ['approve_plan', { planId: 'plan_missing', confirmation: 'approve plan x for y' }],
    ['execute_plan', { planId: 'plan_missing' }],
  ])(
    '%s on an unknown plan id is recorded',
    async (name, args) => {
      // `require(planId)` sat OUTSIDE the try that calls auditRefusal, so five tools
      // refused with an audit delta of zero. A refusal nobody can see afterwards is the
      // half of the trail that matters when someone asks what the assistant tried.
      const { server, audit } = build()
      const client = await connect(server)
      const before = audit.all().length
      await client.callTool({ name, arguments: args as never }).catch(() => undefined)
      expect(audit.all().length).toBeGreaterThan(before)
    },
    60_000,
  )

  it('records the refusal WITHOUT inventing a portal to blame it on', async () => {
    const { server, audit } = build()
    const client = await connect(server)
    await client.callTool({ name: 'validate_plan', arguments: { planId: 'plan_missing' } })
    const e = audit.all().at(-1)
    expect(e?.type).toBe('refused')
    // The plan is what would have carried a portal key, so there is none to record.
    // Guessing one would put a real portal's name on an event it had no part in.
    expect(e?.portalKey).toBe('(none)')
  }, 60_000)

  it('does NOT record a call the schema rejected, and that is deliberate', async () => {
    // A malformed call is refused by zod at the MCP boundary, before any handler
    // runs, so nothing here knows a plan or a portal. Recording it would turn every
    // buggy or hostile client into an unbounded writer of an append-only file that
    // has no delete API, which is #102 and is worse than the gap. Pinned as a
    // DECISION, so the next reader finds the reasoning rather than an oversight.
    const { server, audit } = build()
    const client = await connect(server)
    const before = audit.all().length
    await client
      .callTool({ name: 'approve_plan', arguments: { planId: 'p' } as never })
      .catch(() => undefined)
    expect(audit.all().length).toBe(before)
  }, 60_000)
})

/**
 * Found by the adversarial review of the redaction itself, not by the property test
 * above: redacting KEYS is the right instinct and the obvious implementation loses
 * data. An append-only trail is the one place a silent drop is least acceptable, so
 * both shapes are pinned here.
 */
describe('redacting the trail does not quietly lose part of it (#112)', () => {
  it('keeps a __proto__ key instead of setting a prototype and dropping it', () => {
    // `out["__proto__"] = v` on a plain object sets the PROTOTYPE, so the entry
    // vanished with no error. A plan's `properties` is caller-supplied and
    // `__proto__` is legal JSON. Same class as RT-06.
    const audit = new InMemoryAuditLog()
    audit.record({
      type: 'refused',
      planId: 'plan_1',
      portalKey: 'PORTAL_A',
      at: 1,
      // Built with JSON.parse, not an object literal: in a literal `__proto__:` is
      // special syntax that sets the prototype, so the fixture would not have the own
      // property the bug is about. JSON.parse creates one, and JSON over the wire is
      // exactly how a tool argument reaches this code.
      detail: { properties: JSON.parse('{"__proto__":"carried","keep":"yes"}') },
    } as never)
    const stored = JSON.stringify(audit.all().at(-1))
    expect(stored).toContain('carried')
    expect(stored).toContain('keep')
    // The KEY, not just the value. Asserting only that "carried" survived stopped being
    // enough once collisions were numbered whatever their origin (#123): on a plain `{}`
    // the inherited `"__proto__" in out` reads TRUE, so the entry is RENAMED to
    // `__proto__ #2` and its value survives under a key the caller never sent. The value
    // check therefore passed with the guard removed, and the register said so — a
    // mutation that changes behaviour while the test stays green is the exact shape this
    // register exists to catch, so the test is tightened rather than the entry dropped.
    expect(stored).toContain('"__proto__":"carried"')
  })

  it('keeps both values when two different credential-shaped keys collide', () => {
    // Both redact to the same placeholder, so the second overwrote the first. Losing
    // an entry in order to hide a key trades one problem for a worse one.
    const other = ['pat', 'na1', '1f2e4c6a', '1b3d', '5e7f', '9a0b', 'c1d2e3f4a5b6'].join('-')
    const audit = new InMemoryAuditLog()
    audit.record({
      type: 'refused',
      planId: 'plan_1',
      portalKey: 'PORTAL_A',
      at: 1,
      detail: { properties: { [PAT]: 'first', [other]: 'second' } },
    } as never)
    const stored = JSON.stringify(audit.all().at(-1))
    expect(stored).toContain('first')
    expect(stored).toContain('second')
    expect(stored).not.toContain(PAT)
    expect(stored).not.toContain(other)
  })
})

/**
 * FOUR PROPERTIES, because redaction is a TRANSFORMATION (#123).
 *
 * The describe above was already running when both of #123's findings were made, and it
 * caught neither: it asserts roughly ONE of the four properties a transformation needs,
 * over a PAT only. A transformation needs all four, and the two that were missing are
 * the two that failed:
 *
 *   secrecy             is protected material UNRECOVERABLE, not merely altered?
 *   preservation        are unrelated keys and values still present afterwards?
 *   structural validity is the output still valid JSON, with no duplicate keys?
 *   collision safety    is the normalisation injective, or are collisions disambiguated?
 *
 * Each test below names its own input, and each was confirmed to FAIL against the
 * unfixed code before the fix was written.
 */
describe('redaction is a transformation, so all four properties are pinned (#123)', () => {
  // The header and footer are FIXED, public strings — that is exactly why replacing the
  // header and keeping the body was worthless. Assembled from parts so this file is not
  // itself a credential-shaped literal, per the convention in config.test.ts.
  const BEGIN = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
  const END = ['-----END', 'PRIVATE KEY-----'].join(' ')

  /** A disposable key, GENERATED here: no credential is committed, and it is still real. */
  function disposableKey(): { pem: string; body: string; fingerprint: string } {
    const { privateKey } = generateKeyPairSync('ed25519')
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const der = privateKey.export({ type: 'pkcs8', format: 'der' })
    return {
      pem,
      body: pem
        .split('\n')
        .filter((l) => !l.includes('PRIVATE KEY'))
        .join(''),
      fingerprint: createHash('sha256').update(der).digest('hex'),
    }
  }

  /**
   * The reviewer's own recovery, as an assertion: take every long base64 run the text
   * still carries, put the fixed header and footer back round it, and ask Node to import
   * it. Returns true if any run yields the SAME private key.
   */
  function recoversKey(text: string, fingerprint: string): boolean {
    return (text.match(/[A-Za-z0-9+/=]{40,}/g) ?? []).some((run) => {
      try {
        const der = createPrivateKey(`${BEGIN}\n${run}\n${END}\n`).export({
          type: 'pkcs8',
          format: 'der',
        })
        return createHash('sha256').update(der).digest('hex') === fingerprint
      } catch {
        return false // not importable as a key, which is the outcome this wants
      }
    })
  }

  /** Record one event, then read it back through a DIFFERENT writer, so it comes off disk. */
  function persistAndReload(detail: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), 'audit-reload-'))
    const event = { type: 'refused', planId: 'plan_1', portalKey: 'PORTAL_A', at: 1, detail }
    new FileAuditLog(new JsonlDir(dir, '20260101T000000Z-aaaaaaaa')).record(event as never)
    // A second writer id, because JsonlDir never reads its OWN file back: this is a
    // genuine reload of the durable line, not the in-memory copy that wrote it.
    const reloaded = new FileAuditLog(new JsonlDir(dir, '20260101T000001Z-bbbbbbbb'))
    return String((reloaded.all().at(-1)?.detail as Record<string, unknown> | undefined)?.reason)
  }

  it('SECRECY: a PEM body is unrecoverable from a reloaded trail, terminated or not', () => {
    const { pem, body, fingerprint } = disposableKey()
    expect(body.length, 'a fixture with no body would prove nothing').toBeGreaterThan(40)

    const variants: Array<[string, string]> = [
      ['a terminated PEM block', pem],
      // A header with NO END line is still key material, and the old pattern matched
      // only the header label, so this was the same leak with nothing to anchor on.
      ['an UNTERMINATED PEM block', `${BEGIN}\n${body}`],
    ]
    for (const [label, material] of variants) {
      const reason = persistAndReload({ reason: `object type "${material}" is not allowed` })
      // A BOOLEAN, not `toContain(body)`: the failure diff would otherwise print the key
      // body to the console on every failing run, and a test for not leaking key material
      // must not leak it while failing. The key is disposable, but the habit is the point.
      expect(reason.includes(body), `${label}: the base64 body survived verbatim`).toBe(false)
      expect(
        recoversKey(reason, fingerprint),
        `${label}: the identical private key was recovered from the reloaded trail`,
      ).toBe(false)
    }
  })

  it('PRESERVATION: a key equal to the placeholder overwrites nothing, in either order', () => {
    // The redactor used to number a collision only when the key had CHANGED. An object
    // whose key is LITERALLY the placeholder string does not change, so it landed on a
    // redacted key and overwrote it — a value gone from an append-only trail.
    const placeholder = JSON.stringify(REDACTED_IN_TEXT)
    const orders: Array<[string, string]> = [
      ['credential key first', `{"${PAT}":"first",${placeholder}:"second"}`],
      ['placeholder key first', `{${placeholder}:"second","${PAT}":"first"}`],
    ]
    for (const [label, json] of orders) {
      const audit = new InMemoryAuditLog()
      audit.record({
        type: 'refused',
        planId: 'plan_1',
        portalKey: 'PORTAL_A',
        at: 1,
        // JSON.parse, not a literal: the key ORDER is the input, and this is also how a
        // tool argument actually reaches this code.
        detail: { properties: JSON.parse(json) },
      } as never)
      const stored = JSON.stringify(audit.all().at(-1))
      expect(stored, `${label}: "first" was dropped`).toContain('"first"')
      expect(stored, `${label}: "second" was dropped`).toContain('"second"')
      expect(stored, `${label}: the credential itself was stored`).not.toContain(PAT)
    }
  })

  it('STRUCTURAL VALIDITY: a tool result parses with no duplicate key and loses no property', async () => {
    // Redacting the SERIALIZED JSON minted two identical keys in one object. It parses,
    // which is what made it silent: a parser keeps the LAST, so the caller lost a
    // property while the stored plan kept both.
    const other = ['pat', 'na1', '1f2e4c6a', '1b3d', '5e7f', '9a0b', 'c1d2e3f4a5b6'].join('-')
    const { server, plans } = build()
    const client = await connect(server)
    const r = await client.callTool({
      name: 'draft_plan',
      arguments: {
        portal: 'PORTAL_A',
        operation: {
          kind: 'create',
          objectType: 'notes',
          properties: { [PAT]: 'value-one', [other]: 'value-two' },
        },
      } as never,
    })
    const text = (r.content as Array<{ text: string }>)[0]?.text ?? ''
    expect(text, 'the credential came back in the result').not.toContain(PAT)

    const keyToken = `${JSON.stringify(REDACTED_IN_TEXT)}:`
    expect(
      text.split(keyToken).length - 1,
      'the placeholder appears more than once as a key, so the object has duplicate keys',
    ).toBe(1)

    const parsed = JSON.parse(text) as {
      id: string
      operation: { properties: Record<string, string> }
    }
    const values = Object.values(parsed.operation.properties)
    expect(values, 'a property was lost between the server and the caller').toEqual(
      expect.arrayContaining(['value-one', 'value-two']),
    )
    // The other half of what made it silent: the server kept both all along.
    expect(Object.keys(plans.get(parsed.id).operation.properties)).toHaveLength(2)
  }, 60_000)

  it('COLLISION SAFETY: three keys that redact alike stay three distinct keys', async () => {
    // Injectivity is the property. Two distinct credentials plus a key that is literally
    // the placeholder all normalise to one string, so the redactor must disambiguate all
    // three; a fixed suffix disambiguates only the second.
    const other = ['pat', 'na1', '2f2e4c6a', '1b3d', '5e7f', '9a0b', 'c1d2e3f4a5b6'].join('-')
    const { server } = build()
    const client = await connect(server)
    const r = await client.callTool({
      name: 'draft_plan',
      arguments: {
        portal: 'PORTAL_A',
        operation: {
          kind: 'create',
          objectType: 'notes',
          properties: {
            [PAT]: 'value-one',
            [other]: 'value-two',
            [REDACTED_IN_TEXT]: 'value-three',
          },
        },
      } as never,
    })
    const text = (r.content as Array<{ text: string }>)[0]?.text ?? ''
    const parsed = JSON.parse(text) as { operation: { properties: Record<string, string> } }
    const props = parsed.operation.properties
    expect(Object.keys(props), 'three inputs did not stay three keys').toHaveLength(3)
    expect(Object.values(props)).toEqual(
      expect.arrayContaining(['value-one', 'value-two', 'value-three']),
    )
  }, 60_000)
})

/**
 * The walker is applied to EVERY tool result, not only to audit events, so it must not
 * damage a payload while cleaning it. Rebuilding an arbitrary object from
 * `Object.entries` destroys it: `Object.entries(new Date())` is `[]`, so a Date became
 * `{}` and `{ at: date }` became `{ at: {} }`.
 *
 * No tool result returns a Date today, which is why the suite passed and the defect was
 * latent. That is the same shape as the two findings this file exists to pin: a
 * transformation that quietly loses data while looking correct.
 */
describe('redaction cleans a payload without damaging it', () => {
  const walk = async (v: unknown): Promise<unknown> => {
    const { redactCredentialsDeep } = await import('../config/credential-shape.js')
    return redactCredentialsDeep(v)
  }

  it('leaves a Date intact, so it still serializes as an ISO string', async () => {
    const at = new Date('2026-09-29T00:00:00Z')
    expect(JSON.stringify(await walk(at))).toBe('"2026-09-29T00:00:00.000Z"')
    expect(JSON.stringify(await walk({ at }))).toBe('{"at":"2026-09-29T00:00:00.000Z"}')
  })

  it('still redacts inside a plain object, which is what it is for', async () => {
    expect(JSON.stringify(await walk({ x: PAT }))).not.toContain(PAT)
  })

  it('leaves values that are not objects alone', async () => {
    expect(await walk(7)).toBe(7)
    expect(await walk(true)).toBe(true)
    expect(await walk(null)).toBeNull()
  })
})

/**
 * Whether a redaction happened is recorded by the SERVER, out of band (#147, #148).
 *
 * The marker `(redacted: credential-shaped value)` is not itself credential-shaped, so a
 * caller can type it and nothing transforms it. Before this, a stored refusal reason was
 * byte-identical whether the server redacted something or the caller wrote the marker,
 * and the log could therefore record a redaction that never happened. Escaping the
 * marker on the way in would be a race against the next way to spell it, so the fact
 * moved to a field a caller cannot reach.
 */
describe('the audit sink records what IT redacted, not what the caller claims', () => {
  const event = (reason: string, extra: Record<string, unknown> = {}) => ({
    type: 'refused' as const,
    planId: 'plan_x',
    portalKey: 'PORTAL_A',
    at: 1,
    ...extra,
    detail: { stage: 'draft', reason },
  })
  const stored = (ev: Parameters<InMemoryAuditLog['record']>[0]) => {
    const log = new InMemoryAuditLog()
    log.record(ev)
    const e = log.all()[0]
    // Thrown rather than asserted non-null: a sink that recorded nothing is a real
    // failure and should say so here, not produce a confusing assertion further down.
    if (e === undefined) throw new Error('the audit sink recorded no event')
    return e
  }

  it('records a handle when it redacts something', () => {
    const e = stored(event(`object type "${PAT}" is not allowed`))
    expect(e.detail?.reason).toContain(REDACTED_IN_TEXT)
    expect(e.redacted).toHaveLength(1)
    expect(e.redacted?.[0]).toMatch(/^[0-9a-f]{8}$/)
  })

  it('records nothing when there was nothing to redact', () => {
    const e = stored(event('object type "not_a_real_type" is not allowed'))
    expect(e.detail?.reason).toContain('not_a_real_type')
    // Absent, not empty: an empty array would read as "a redaction with no handle".
    expect(e.redacted).toBeUndefined()
  })

  // THE forgery. The reason text here is byte-identical to the first case above; only
  // the absence of the field separates them, which is the whole point.
  it('leaves no handle when the caller merely TYPES the marker', () => {
    const e = stored(event(`object type "${REDACTED_IN_TEXT}" is not allowed`))
    expect(e.detail?.reason).toContain(REDACTED_IN_TEXT)
    expect(e.redacted).toBeUndefined()
  })

  // Not the safety guard: the explicit assignment after the spread already overwrites a
  // caller's field, measured. This pins the SEMANTICS — absent means nothing was
  // redacted, where an empty array would read as a redaction with no handle.
  it('discards a redacted field the caller supplied', () => {
    const e = stored(
      event(`object type "${REDACTED_IN_TEXT}" is not allowed`, { redacted: ['deadbeef'] }),
    )
    expect(e.redacted).toBeUndefined()
  })

  it('overwrites a forged field rather than merging with it', () => {
    const e = stored(event(`object type "${PAT}" is not allowed`, { redacted: ['deadbeef'] }))
    expect(e.redacted).toHaveLength(1)
    expect(e.redacted).not.toContain('deadbeef')
  })

  // #148: the same value is recognisable across events without ever being stored.
  it('gives the same value the same handle in different events', () => {
    const a = stored(event(`object type "${PAT}" is not allowed`))
    const b = stored(event(`a different sentence mentioning ${PAT}`))
    expect(b.redacted).toEqual(a.redacted)
  })

  it('gives different values different handles', () => {
    const other = ['pat', 'na1', 'ffffffff', 'eeee', 'dddd', 'cccc', 'bbbbbbbbbbbb'].join('-')
    const a = stored(event(`object type "${PAT}" is not allowed`))
    const b = stored(event(`object type "${other}" is not allowed`))
    expect(b.redacted).not.toEqual(a.redacted)
  })
})
