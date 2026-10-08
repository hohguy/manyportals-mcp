import { describe, it, expect } from 'vitest'
import { createHash, createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeConfigProvider, loadConfig } from '../config/index.js'
import { REDACTED_IN_TEXT } from '../config/credential-shape.js'
import { PortalRegistry } from '../portals/index.js'
import { FakeHubSpotClient } from '../hubspot/fake.js'
import type { HubSpotClient } from '../hubspot/index.js'
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

/**
 * `resolveToken` and `hubspot` are injectable for the #206 block at the end of this file,
 * which needs a CONFIGURED token value of its own choosing and a client that fails with
 * it. Every other caller takes the defaults and is unaffected.
 */
function build(
  resolveToken: (portalKey: string) => string = (k) => `tok-${k}`,
  hubspot: HubSpotClient = new FakeHubSpotClient(),
) {
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
  const client = hubspot
  const idIndex = new PortalIdIndex()
  const audit = new InMemoryAuditLog()
  const plans = new PlanService({
    registry,
    client,
    idIndex,
    audit,
    resolveToken,
    writeMode: 'propose',
  })
  const reads = new ReadService({ registry, client, idIndex, resolveToken })
  const server = createMcpServer({ registry, plans, reads, audit })
  return { server, audit, plans, registry, client }
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
 *
 * WHAT IT CANNOT GENERATE, named here so the next reader does not trust it further than
 * it goes (#184). It aims at VALID arguments, so it only ever reaches a HANDLER, and the
 * `object` case returns `{}` for a schema with no `properties` — which is exactly the
 * JSON Schema of `z.record(z.string(), z.string())`, so `draft_plan`'s `properties`
 * arrives empty. Both limits point at the same uncovered class: arguments zod REJECTS,
 * where the SDK answers from the issue list and the issue `path` carries the caller's
 * property names. That class is pinned by hand in the `#184` describe below, not here;
 * widening this function cannot reach it, because an argument it generates is one that
 * validates.
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

  /**
   * SAFETY.md "Token values stay out of results.", the sentence (#206): "Text that you or
   * the assistant supply is a separate matter: a value shaped like a HubSpot personal
   * access token or a PEM private key is removed before a result is returned and before an
   * event is stored, and a secret of some other shape is not recognised."
   *
   * Registered in scripts/claims-register.json. The sentence names two SHAPES across two
   * SURFACES and then states a limit, so all three parts run here: the pass above covers
   * the PAT shape across every tool and is bound to the heading of the "Errors are cleaned"
   * bullet's own surface, not to this sentence, and it says nothing about PEM or about what
   * is NOT recognised.
   *
   * The last clause is the load-bearing one and it is a CHARACTERIZATION, so it is asserted
   * in the positive: a secret of another shape comes back and is stored AS WRITTEN. The
   * ticket's own list puts `MANYPORTALS_VAULT_KEY` in that class, which is why the bullet
   * says it out loud. Without this case a redactor that had started blanking everything
   * would read as the page being faithful.
   */
  it('a PAT and a PEM key are removed from the result and the trail; a secret of another shape is not', async () => {
    const { server, audit } = build()
    const client = await connect(server)
    const { privateKey } = generateKeyPairSync('ed25519')
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const pemBody = pem.split('\n')[1] ?? ''
    // A bare uuid: the legacy hapikey shape, which the ticket records as unrecognised.
    // Assembled from parts for the reason the PAT above is.
    const otherShape = ['0f2e4c6a', '1b3d', '5e7f', '9a0b', 'c1d2e3f4a5b6'].join('-')

    // SURFACE 1 — the result. add_note echoes the compiled operation back.
    const noteResult = async (body: string): Promise<string> =>
      JSON.stringify(
        await client.callTool({
          name: 'add_note',
          arguments: { portal: 'PORTAL_A', body } as never,
        }),
      )
    const patResult = await noteResult(PAT)
    expect(patResult).toContain(REDACTED_IN_TEXT)
    expect(patResult).not.toContain(PAT)

    expect(pemBody, 'the generated key has no body line, so the PEM case proves nothing').not.toBe(
      '',
    )
    const pemResult = await noteResult(pem)
    expect(pemResult).toContain(REDACTED_IN_TEXT)
    expect(pemResult).not.toContain(pemBody)

    // The limit, asserted in the positive.
    expect(await noteResult(otherShape)).toContain(otherShape)

    // SURFACE 2 — the stored event. A refused draft records its reason, and the reason
    // quotes the object type the caller chose.
    const before = audit.all().length
    for (const value of [PAT, pem, otherShape]) {
      await client.callTool({
        name: 'draft_plan',
        arguments: {
          portal: 'PORTAL_A',
          operation: { kind: 'create', objectType: value, properties: {} },
        } as never,
      })
    }
    const lines = audit
      .all()
      .slice(before)
      .map((e) => JSON.stringify(e))
    expect(lines, 'no refusal was recorded, so the trail proves nothing').toHaveLength(3)
    expect(
      lines.filter((l) => l.includes(PAT) || l.includes(pemBody)),
      'these stored events kept the credential',
    ).toEqual([])
    expect(
      lines.filter((l) => l.includes(otherShape)),
      'the unrecognised shape is what the sentence says is stored as written',
    ).toHaveLength(1)
  }, 60_000)
})

/**
 * The CONFIGURED portal token, which is a different claim from the block above and from
 * the #184 block below. Caller-supplied text is recognised by SHAPE and the coverage of
 * that recogniser is one PAT form and one PEM form; a configured token stays out of every
 * outgoing surface for a STRUCTURAL reason instead — it has one consumer, the Authorization
 * header — and that is what these two cases assert (#206).
 */
describe('a configured portal token reaches no result, no trail line and no error (#206)', () => {
  /**
   * Deliberately NOT credential-shaped. With a PAT-shaped token the redactor would strip
   * it on the way out and these tests would pass by proving the redactor works, rather
   * than that the value is never placed in an outgoing message at all.
   */
  const TOKEN = 'configured-portal-token-value-not-credential-shaped'

  /** Every advertised tool, each called with arguments that reach its handler. */
  async function everyToolAnswer(client: Client, planId: string): Promise<string[]> {
    const { tools } = await client.listTools()
    expect(tools.length).toBeGreaterThan(10) // the property is worthless over an empty list
    const out: string[] = []
    for (const tool of tools) {
      const args = argsFor(tool.inputSchema as JsonSchema, 'zzz', {
        portalKey: 'PORTAL_A',
        planId,
        targetPortal: 'PORTAL_A',
      })
      try {
        out.push(
          `${tool.name}: ${JSON.stringify(
            await client.callTool({ name: tool.name, arguments: args as never }),
          )}`,
        )
      } catch (e) {
        // A protocol-level rejection is still output the caller sees.
        out.push(`${tool.name}: ${String(e)}`)
      }
    }
    expect(out, 'not every advertised tool was called').toHaveLength(tools.length)
    return out
  }

  /**
   * THE HEADING TEST for SAFETY.md's "Token values stay out of results." (#206).
   *
   * Registered in scripts/claims-register.json. The heading quantifies over RESULTS, so
   * this enumerates the whole tool surface from the list the server itself advertises
   * rather than sampling a tool: the ticket's verdict on the old wording was
   * UNPROVABLE-AS-WRITTEN, and a sampled test is exactly how an unprovable sentence reads
   * as proven.
   *
   * The control is that the token was IN PLAY. The fake records the token each call went
   * out under, so a run in which the value never reached the HubSpot boundary — a fixture
   * that resolved some other token, or reads that never happened — fails here instead of
   * reporting a clean surface it never exercised.
   *
   * The complementary surfaces, the trail and error messages, are the next sentence and
   * have their own case below.
   */
  it('no result from any registered tool carries the configured portal token', async () => {
    const hubspot = new FakeHubSpotClient()
    const { server, plans } = build(() => TOKEN, hubspot)
    const client = await connect(server)
    const plan = plans.draft({
      portalKey: 'PORTAL_A',
      operation: { kind: 'create', objectType: 'notes', properties: { hs_note_body: 'hi' } },
    })
    const answers = await everyToolAnswer(client, plan.id)

    expect(
      hubspot.calls.some((c) => c.token === TOKEN),
      'the configured token never reached the HubSpot boundary, so nothing was exercised',
    ).toBe(true)
    expect(
      answers.filter((a) => a.includes(TOKEN)).map((a) => a.slice(0, a.indexOf(':'))),
      'these tool results carried the configured portal token',
    ).toEqual([])
  }, 60_000)

  /**
   * SAFETY.md "Token values stay out of results.", the sentence (#206): "Your configured
   * tokens are never placed in a tool result, in the audit log, or in an error message."
   *
   * Registered in scripts/claims-register.json. Three surfaces, and the heading above pins
   * the first one on the ordinary path. This one pins the two the heading does not name,
   * under the condition that actually puts a token on them: a HubSpot client that FAILS
   * with the token in its message. A raw `Error`, not a `SafeError`, so the genericizer is
   * what has to answer.
   *
   * The hostile client is proven hostile FIRST. Its message is asserted to carry the token
   * when called directly, so the empty offender lists afterwards are a measurement rather
   * than an artefact of a client that was never carrying anything (#124). The generic
   * message is required to have reached the caller for the same reason: it is the evidence
   * that the error path was entered at all.
   */
  it('neither the trail nor an error message carries it, even when HubSpot fails with the token', async () => {
    const hostile = new Proxy({} as HubSpotClient, {
      get:
        () =>
        (ctx: { token: string }): never => {
          throw new Error(`upstream rejected Authorization: Bearer ${ctx.token}`)
        },
    })
    let direct = ''
    try {
      await hostile.getAccountInfo({ token: TOKEN, apiHost: 'api.hubapi.com' })
    } catch (e) {
      direct = String(e)
    }
    expect(direct, 'the hostile client does not carry the token, so this proves nothing').toContain(
      TOKEN,
    )

    const { server, audit, plans } = build(() => TOKEN, hostile)
    const client = await connect(server)
    const plan = plans.draft({
      portalKey: 'PORTAL_A',
      operation: { kind: 'create', objectType: 'notes', properties: { hs_note_body: 'hi' } },
    })
    plans.validate(plan.id)
    const answers = await everyToolAnswer(client, plan.id)

    expect(
      answers.filter((a) => a.includes('an internal error occurred')).length,
      'no tool answered with the generic message, so the error path was never entered',
    ).toBeGreaterThan(0)
    expect(
      answers.filter((a) => a.includes(TOKEN)).map((a) => a.slice(0, a.indexOf(':'))),
      'these error messages carried the configured portal token',
    ).toEqual([])

    const trail = audit.all().map((e) => JSON.stringify(e))
    expect(trail.length, 'nothing was recorded, so the trail proves nothing').toBeGreaterThan(0)
    expect(
      trail.filter((line) => line.includes(TOKEN)),
      'these trail lines recorded the configured portal token',
    ).toEqual([])
  }, 60_000)
})

/**
 * PINNED, because the generated pass above CANNOT REACH this input class (#184).
 *
 * That pass is still the right shape for everything it reaches, and it reaches only
 * HANDLERS. `argsFor` builds VALID arguments on purpose, so every call it makes gets past
 * zod and into a handler, where `ok`/`fail` redact. A call zod REJECTS never reaches a
 * handler at all: the bundled SDK answers that one itself, out of the zod issue list, and
 * an issue's `path` carries the caller's own property NAMES.
 *
 * And the blind spot is total rather than partial. `argsFor` returns `{}` for an `object`
 * schema with no `properties`, which is exactly the JSON Schema of
 * `z.record(z.string(), z.string())` — `draft_plan`'s `properties`. The one input class
 * that walks past the chokepoint is the one class the generator emits as an empty object,
 * so that pass could never have gone red here however many tools it grew to cover. A
 * guard that cannot fail over a whole input class reads green forever (#113, #124), which
 * is why these cases are written out by hand instead of derived from a schema.
 *
 * MEASURED against the unfixed code on 2026-10-05 and recorded per case below: the first
 * four came back carrying the credential verbatim in `content[0].text`, the rest did not.
 * The rest are kept and labelled rather than dropped — zod v4 reports an issue's `path`
 * but not the received VALUE, so a type mismatch on a tool whose inputs are all named
 * fields has nothing to leak today. They are the regression surface for the day one of
 * those tools grows a record-shaped input, or the error text starts echoing the input.
 * The labels are not prose: the second test below asserts them.
 */
describe('a call rejected before dispatch is redacted too (#184)', () => {
  /** [what it is, tool name, arguments, whether it carried the credential before the fix] */
  const REJECTED: Array<[string, string, unknown, 'leaked' | 'clean']> = [
    [
      'a credential-shaped property name whose value is a number',
      'draft_plan',
      {
        portal: 'PORTAL_A',
        operation: { kind: 'create', objectType: 'notes', properties: { [PAT]: 5 } },
      },
      'leaked',
    ],
    [
      'a credential-shaped property name whose value is null',
      'draft_plan',
      {
        portal: 'PORTAL_A',
        operation: { kind: 'create', objectType: 'notes', properties: { [PAT]: null } },
      },
      'leaked',
    ],
    [
      'a credential-shaped property name on the update branch of the union',
      'draft_plan',
      {
        portal: 'PORTAL_A',
        operation: {
          kind: 'update',
          objectType: 'deals',
          objectId: '1',
          properties: { [PAT]: true },
        },
      },
      'leaked',
    ],
    // Not a schema rejection at all: the SDK answers an unknown tool with its own
    // `Tool <name> not found`, interpolating the name as given.
    ['a credential-shaped tool NAME', PAT, {}, 'leaked'],
    [
      'get_record: a type-mismatched objectId, keyed by the credential',
      'get_record',
      { portal: 'PORTAL_A', objectType: 'contacts', objectId: { [PAT]: 1 } },
      'clean',
    ],
    [
      'search_records: a type-mismatched filter value, keyed by the credential',
      'search_records',
      {
        portal: 'PORTAL_A',
        objectType: 'contacts',
        filters: [{ propertyName: 'x', operator: 'EQ', value: { [PAT]: 1 } }],
      },
      'clean',
    ],
    [
      'recent_activity: the credential where a number belongs',
      'recent_activity',
      { portal: 'PORTAL_A', limit: PAT },
      'clean',
    ],
    [
      'set_default_read_portal: the credential as a portal key',
      'set_default_read_portal',
      { portal: PAT },
      'clean',
    ],
    // The PROTOCOL error path, and the reason the redaction sits at the transport rather
    // than on tool results: arguments that are not an object fail the request schema, so
    // this is answered as a JSON-RPC ERROR and never becomes a CallToolResult at all. A
    // hook on tool results would not see it.
    ['get_record: the arguments are not an object at all', 'get_record', PAT, 'clean'],
  ]

  async function callEach(): Promise<{
    audited: number
    calls: Array<{ label: string; expected: 'leaked' | 'clean'; text: string }>
  }> {
    const { server, audit } = build()
    const client = await connect(server)
    const before = audit.all().length
    const calls: Array<{ label: string; expected: 'leaked' | 'clean'; text: string }> = []
    for (const [label, name, args, expected] of REJECTED) {
      let text: string
      try {
        text = JSON.stringify(await client.callTool({ name, arguments: args as never }))
      } catch (e) {
        // A protocol-level rejection is thrown at the client rather than returned as a
        // result. It is still output the assistant sees, so it counts here.
        text = String(e)
      }
      calls.push({ label, expected, text })
    }
    return { audited: audit.all().length - before, calls }
  }

  it('no rejected call echoes the credential back', async () => {
    const { calls } = await callEach()
    expect(
      calls.filter((c) => c.text.includes(PAT)).map((c) => c.label),
      'these rejected calls echoed the credential back to the assistant',
    ).toEqual([])
  }, 60_000)

  // The labels above are a MEASUREMENT, so they are checked rather than trusted. A case
  // marked clean that starts carrying a credential shows up here as a redaction nobody
  // recorded, which is the prompt to re-measure — and a fix that stops redacting shows up
  // as a `leaked` case with no placeholder left in it.
  it('redacts exactly the cases recorded as leaking, and no others', async () => {
    const { calls } = await callEach()
    expect(
      calls.filter((c) => c.text.includes(REDACTED_IN_TEXT)).map((c) => c.label),
      'the per-case measurement in this list no longer matches what the server does',
    ).toEqual(calls.filter((c) => c.expected === 'leaked').map((c) => c.label))
  }, 60_000)

  // The other half of the #184 fix, and the easier half to get wrong: redacting the way
  // OUT must not start writing anything DOWN. The decision that a schema-rejected call
  // goes unrecorded is pinned below ('does NOT record a call the schema rejected'); this
  // extends it from one call to the whole list.
  it('records none of them, whatever it had to redact', async () => {
    const { audited } = await callEach()
    expect(audited, 'a rejected call was written to the append-only trail').toBe(0)
  }, 60_000)

  /**
   * THE COST OF AN OUTER NET, paid rather than ignored.
   *
   * The transport pass covers the same property as `ok`/`fail` and sits further out, so
   * an end-to-end call can no longer tell a working `fail` from one that stopped
   * redacting: the net catches it either way. The guard register said exactly that on the
   * day the net landed — `mcp/credential-shapes-never-returned` reported THE GUARD CANNOT
   * FAIL, with the three-pass property test green under its mutation. A layer nobody can
   * observe is a layer nobody can prove, and the honest repair is to observe it, not to
   * delete it and not to shrink the net back around it.
   *
   * So this watches the handler's own output, by wrapping `send` AFTER `connect`. By then
   * `transport.send` IS the redacting wrapper, so a wrapper installed on top of it runs
   * FIRST and sees what the handler produced before the net has touched it. Both layers
   * are then provable separately, which is the same reasoning as the two audit sinks
   * having an entry each: one layer forgetting is exactly what a single shared proof
   * hides.
   */
  it('the handler chokepoint still redacts on its own, under the net', async () => {
    const { server } = build()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'credential-echo', version: '0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const beforeTheNet: string[] = []
    const net = serverTransport.send.bind(serverTransport)
    serverTransport.send = async (message, options) => {
      beforeTheNet.push(JSON.stringify(message))
      await net(message, options)
    }

    // An object type that is not allow-listed, so the refusal interpolates the caller's
    // own word: `object type "<objectType>" is not allowed`, which is the #112 7a shape
    // and reaches the client through `fail`.
    await client.callTool({
      name: 'draft_plan',
      arguments: {
        portal: 'PORTAL_A',
        operation: { kind: 'create', objectType: PAT, properties: { hs_note_body: 'hi' } },
      } as never,
    })

    expect(
      beforeTheNet.length,
      'nothing was captured, so this test proves nothing',
    ).toBeGreaterThan(0)
    expect(
      beforeTheNet.filter((m) => m.includes(PAT)),
      'the handler built a message carrying the credential and only the transport net stopped it',
    ).toEqual([])
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
