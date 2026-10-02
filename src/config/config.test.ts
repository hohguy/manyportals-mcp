import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  ConfigError,
  DEFAULT_API_HOST,
  EnvTokenSource,
  FakeConfigProvider,
  FileConfigProvider,
  MapTokenSource,
  createTokenResolver,
  loadConfig,
  looksLikeCredential,
  readTokenFile,
  type PortalConfig,
} from './index.js'

const validRaw = {
  portals: {
    PORTAL_A: {
      tokenEnv: 'HUBSPOT_TOKEN_PORTAL_A',
      expectedHubId: 123456789,
      label: 'Portal A',
      allowWrite: true,
    },
    PORTAL_B: {
      tokenEnv: 'HUBSPOT_TOKEN_PORTAL_B',
      expectedHubId: 0,
      label: 'Portal B',
      allowWrite: false,
    },
  },
  writeMode: 'propose',
}

describe('loadConfig', () => {
  it('accepts a valid config and applies defaults', () => {
    const cfg = loadConfig(new FakeConfigProvider(validRaw))
    expect(Object.keys(cfg.portals)).toEqual(['PORTAL_A', 'PORTAL_B'])
    expect(cfg.portals.PORTAL_A?.apiHost).toBe(DEFAULT_API_HOST)
    expect(cfg.portals.PORTAL_A?.blockedProperties).toEqual([])
    expect(cfg.portals.PORTAL_A?.allowRead).toBe(true) // reads default-on; allowWrite default-off
    expect(cfg.writeMode).toBe('propose')
  })

  it('honors allowRead=false to park a portal from the read tools', () => {
    const raw = {
      portals: {
        PORTAL_A: { tokenEnv: 'X', expectedHubId: 1, label: 'A', allowRead: false },
      },
    }
    expect(loadConfig(new FakeConfigProvider(raw)).portals.PORTAL_A?.allowRead).toBe(false)
  })

  it('defaults writeMode to propose when omitted', () => {
    const cfg = loadConfig(new FakeConfigProvider({ portals: validRaw.portals }))
    expect(cfg.writeMode).toBe('propose')
  })

  it('rejects an empty portal map', () => {
    expect(() => loadConfig(new FakeConfigProvider({ portals: {} }))).toThrow(ConfigError)
  })

  it('rejects a portal missing a label', () => {
    const bad = { portals: { PORTAL_A: { tokenEnv: 'X', expectedHubId: 1 } } }
    expect(() => loadConfig(new FakeConfigProvider(bad))).toThrow(/label/)
  })

  it('rejects an unknown writeMode', () => {
    expect(() => loadConfig(new FakeConfigProvider({ ...validRaw, writeMode: 'yolo' }))).toThrow(
      ConfigError,
    )
  })

  it('rejects unknown keys (strict schema catches typos)', () => {
    const bad = {
      portals: { PORTAL_A: { tokenEnv: 'X', expectedHubId: 1, label: 'A', surprise: true } },
    }
    expect(() => loadConfig(new FakeConfigProvider(bad))).toThrow(ConfigError)
  })

  it('allows expectedHubId 0 (unknown → boot assertion skips later) on a read-only portal', () => {
    const cfg = loadConfig(new FakeConfigProvider(validRaw))
    expect(cfg.portals.PORTAL_B?.expectedHubId).toBe(0)
    expect(cfg.portals.PORTAL_B?.allowWrite).toBe(false)
  })

  it('rejects a WRITABLE portal with an unknown (0) hub id (fail-closed swapped-token guard)', () => {
    const bad = {
      portals: {
        PORTAL_A: { tokenEnv: 'X', expectedHubId: 0, label: 'A', allowWrite: true },
      },
    }
    expect(() => loadConfig(new FakeConfigProvider(bad))).toThrow(/nonzero expectedHubId/)
  })

  it('rejects a tokenEnv that looks like a token value, not an env var name', () => {
    const bad = {
      portals: {
        PORTAL_A: { tokenEnv: 'pat-na1-abc123', expectedHubId: 1, label: 'A', allowWrite: false },
      },
    }
    expect(() => loadConfig(new FakeConfigProvider(bad))).toThrow(
      /tokenEnv must be an environment variable NAME/,
    )
  })

  it('rejects an apiHost outside the egress allowlist', () => {
    const bad = {
      portals: {
        PORTAL_A: { tokenEnv: 'X', expectedHubId: 1, label: 'A', apiHost: 'evil.example.com' },
      },
    }
    expect(() => loadConfig(new FakeConfigProvider(bad))).toThrow(/apiHost/)
  })

  it('accepts the allowlisted apiHost', () => {
    const cfg = loadConfig(
      new FakeConfigProvider({
        portals: {
          PORTAL_A: { tokenEnv: 'X', expectedHubId: 1, label: 'A', apiHost: DEFAULT_API_HOST },
        },
      }),
    )
    expect(cfg.portals.PORTAL_A?.apiHost).toBe(DEFAULT_API_HOST)
  })

  describe('config errors never echo a pasted secret (R4.3, all channels)', () => {
    const SECRET = 'pat-na1-DEADBEEF-SUPERSECRETTOKEN'
    const errMsg = (raw: unknown): string => {
      try {
        loadConfig(new FakeConfigProvider(raw))
        return ''
      } catch (e) {
        return (e as Error).message
      }
    }

    it('redacts a secret pasted as an unrecognized property key (inside a portal body)', () => {
      const msg = errMsg({
        ...validRaw,
        portals: {
          ...validRaw.portals,
          PORTAL_A: { ...validRaw.portals.PORTAL_A, [SECRET]: 'x' },
        },
      })
      expect(msg).toMatch(/unrecognized key/i)
      expect(msg).not.toContain(SECRET)
    })

    it('redacts a secret pasted as a PORTAL KEY (path segment) — the R4-review follow-up', () => {
      // token fat-pasted where a short portal key belongs; a missing required field fires an issue
      const msg = errMsg({ portals: { [SECRET]: { label: 'x' } }, writeMode: 'propose' })
      expect(msg).not.toBe('') // it DID fail validation
      expect(msg).not.toContain(SECRET)
    })

    it('redacts a secret pasted as an enum VALUE (writeMode)', () => {
      const msg = errMsg({ ...validRaw, writeMode: SECRET })
      expect(msg).not.toBe('')
      expect(msg).not.toContain(SECRET)
    })
  })
})

describe('the shipped default write mode is propose (product decision, 2026-09-26)', () => {
  // Releases ship `propose`: no write reaches HubSpot until a person approves it and
  // names its portal. An operator may choose `apply` at their own risk, but nothing we
  // ship may choose it for them — so both the schema default and the example config
  // that people copy are pinned here.
  it('omitting writeMode yields propose', () => {
    const cfg = loadConfig(
      new FakeConfigProvider({
        portals: { PORTAL_A: { expectedHubId: 111, label: 'Portal A', allowWrite: false } },
      }),
    )
    expect(cfg.writeMode).toBe('propose')
  })

  it('the example config operators copy sets propose', () => {
    // Two layouts: authored at docs/ in the dev repo, assembled to examples/ in the
    // public repo, where this test also runs under publish-sync --verify.
    const candidates = [
      join(process.cwd(), 'docs', 'manyportals.config.example.json'),
      join(process.cwd(), 'examples', 'manyportals.config.example.json'),
    ]
    const path = candidates.find((p) => existsSync(p))
    if (path === undefined)
      throw new Error(`example config not found: tried ${candidates.join(', ')}`)
    const example = JSON.parse(readFileSync(path, 'utf8')) as { writeMode?: string }
    expect(example.writeMode).toBe('propose')
  })
})

describe('FileConfigProvider', () => {
  const validJson = JSON.stringify(validRaw)

  it('reads and parses a JSON portal map from disk (via the injected reader)', () => {
    const provider = new FileConfigProvider('/cfg/manyportals.json', () => validJson)
    const cfg = loadConfig(provider)
    expect(Object.keys(cfg.portals)).toEqual(['PORTAL_A', 'PORTAL_B'])
  })

  it('throws a ConfigError naming the path (not contents) when the file is unreadable', () => {
    const provider = new FileConfigProvider('/cfg/missing.json', () => {
      throw new Error('ENOENT')
    })
    let caught: unknown
    try {
      provider.read()
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConfigError)
    expect((caught as Error).message).toContain('/cfg/missing.json')
  })

  it('throws a ConfigError on invalid JSON', () => {
    const provider = new FileConfigProvider('/cfg/bad.json', () => '{ not json')
    expect(() => provider.read()).toThrow(/valid JSON/)
  })
})

describe('token sources', () => {
  const cfg = loadConfig(new FakeConfigProvider(validRaw))
  const portalA = cfg.portals.PORTAL_A!
  const fileBacked: PortalConfig = { ...portalA, tokenEnv: undefined }

  it('EnvTokenSource reads the token from the named env var (undefined when missing)', () => {
    expect(new EnvTokenSource({ HUBSPOT_TOKEN_PORTAL_A: 'pat-x' }).get('PORTAL_A', portalA)).toBe(
      'pat-x',
    )
    expect(new EnvTokenSource({}).get('PORTAL_A', portalA)).toBeUndefined()
  })

  it('MapTokenSource reads the token from a portalKey -> token map', () => {
    const src = new MapTokenSource({ PORTAL_A: 'pat-from-file' })
    expect(src.get('PORTAL_A')).toBe('pat-from-file')
    expect(src.get('PORTAL_Z')).toBeUndefined()
  })

  it('createTokenResolver prefers env, then falls back to the token file', () => {
    const resolve = createTokenResolver([
      new EnvTokenSource({ HUBSPOT_TOKEN_PORTAL_A: 'pat-env' }),
      new MapTokenSource({ PORTAL_A: 'pat-file' }),
    ])
    expect(resolve('PORTAL_A', portalA)).toBe('pat-env')

    const fileOnly = createTokenResolver([
      new EnvTokenSource({}),
      new MapTokenSource({ PORTAL_A: 'pat-file' }),
    ])
    expect(fileOnly('PORTAL_A', portalA)).toBe('pat-file')
  })

  it('resolves a token for a portal with no tokenEnv from the token file', () => {
    const resolve = createTokenResolver([
      new EnvTokenSource({}),
      new MapTokenSource({ PORTAL_A: 'pat-file' }),
    ])
    expect(resolve('PORTAL_A', fileBacked)).toBe('pat-file')
  })

  it('throws a token-free error when no source has the token', () => {
    const resolve = createTokenResolver([new EnvTokenSource({}), new MapTokenSource({})])
    let caught: unknown
    try {
      resolve('PORTAL_A', portalA)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConfigError)
    const msg = (caught as Error).message
    expect(msg).toContain('PORTAL_A')
    expect(msg).not.toContain('pat-') // never leak token material
  })

  it('RT-06: a prototype-member portal/env key never returns the inherited function (no TypeError)', () => {
    expect(new MapTokenSource({}).get('toString')).toBeUndefined()
    expect(new MapTokenSource({}).get('constructor')).toBeUndefined()
    const protoPortal: PortalConfig = { ...portalA, tokenEnv: 'toString' }
    expect(new EnvTokenSource({}).get('PORTAL_A', protoPortal)).toBeUndefined()
  })

  it('RT-06: a "__proto__" portal key survives the token file as a real own entry', () => {
    const map = readTokenFile('/cfg/t.json', () => '{"__proto__":"pat-proto"}')
    expect(new MapTokenSource(map).get('__proto__')).toBe('pat-proto')
  })
})

describe('RT-10a: portal key/label grammar + credential reject + NFC', () => {
  const portal = (label = 'L') => ({ tokenEnv: 'A', expectedHubId: 1, label, allowWrite: false })
  const load = (portals: Record<string, unknown>) =>
    loadConfig(new FakeConfigProvider({ portals, writeMode: 'propose' }))

  it('accepts keys in any script and emoji labels', () => {
    const c = load({ ACME: portal('Acme Corp'), 会社2: portal('株式会社アクメ 🎌') })
    expect(Object.keys(c.portals).sort()).toEqual(['ACME', '会社2'].sort())
  })

  it('rejects a key with path/structural, space, or bidi characters', () => {
    expect(() => load({ 'a/b': portal() })).toThrow(ConfigError)
    expect(() => load({ '..': portal() })).toThrow(ConfigError)
    expect(() => load({ 'a b': portal() })).toThrow(ConfigError)
    expect(() => load({ 'ac‮me': portal() })).toThrow(ConfigError) // bidi override
  })

  it('rejects a token-shaped key or label — redacted, no echo', () => {
    // Assembled from parts, NOT a contiguous literal. This must match
    // CREDENTIAL_SHAPE to exercise the reject path, but a contiguous
    // `pat-<region>-<uuid>` literal in src/ would (correctly) trip the
    // publish-sync leak scanner, which enforces the same shape over the
    // wholesale-copied src tree. Assembling it keeps that scanner strict —
    // real leaks are pasted as contiguous literals, which it still catches.
    const tok = ['pat-na1', '0f2e4c6a', '1b3d', '5e7f', '9a0b', 'c1d2e3f4a5b6'].join('-')
    let caught: unknown
    try {
      load({ [tok]: portal() })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConfigError)
    expect((caught as Error).message).not.toContain(tok)
    expect(() => load({ OK: portal(tok) })).toThrow(/token or secret/)
  })

  it('rejects a bidi/control character in a label', () => {
    expect(() => load({ OK: portal('Ac‮me') })).toThrow(/control|bidi|zero-width/i)
  })

  it('NFC-normalizes keys and refuses a normalization collision', () => {
    // composed (U+00E9) vs base + combining acute (U+0301) -> same NFC
    const composed = 'caf\u00e9'
    const decomposed = 'cafe\u0301'
    const two: Record<string, unknown> = {}
    two[composed] = portal()
    two[decomposed] = portal()
    expect(() => load(two)).toThrow(/normaliz/i)
    expect(Object.keys(load({ [decomposed]: portal() }).portals)).toEqual([composed])
  })
})

describe('readTokenFile', () => {
  it('parses a portalKey -> token JSON map', () => {
    const map = readTokenFile('/cfg/tokens.json', () => '{"PORTAL_A":"pat-a","PORTAL_B":"pat-b"}')
    expect(map).toEqual({ PORTAL_A: 'pat-a', PORTAL_B: 'pat-b' })
  })

  it('returns an empty map when the file is absent (env-only still works)', () => {
    const map = readTokenFile('/cfg/missing.json', () => {
      const e = new Error('ENOENT: no such file') as NodeJS.ErrnoException
      e.code = 'ENOENT'
      throw e
    })
    expect(map).toEqual({})
  })

  it('FAILS LOUD on a non-ENOENT read error (EACCES/EISDIR) — no silent downgrade', () => {
    expect(() =>
      readTokenFile('/cfg/locked.json', () => {
        const e = new Error('EACCES: permission denied') as NodeJS.ErrnoException
        e.code = 'EACCES'
        throw e
      }),
    ).toThrow(/could not be read/)
  })

  it('throws a ConfigError (path only) on invalid JSON or a non-object/array shape', () => {
    expect(() => readTokenFile('/cfg/bad.json', () => '{ not json')).toThrow(/valid JSON/)
    expect(() => readTokenFile('/cfg/arr.json', () => '["pat-x"]')).toThrow(/JSON object/)
    expect(() => readTokenFile('/cfg/num.json', () => '{"PORTAL_A": 123}')).toThrow(
      /must be a string/,
    )
  })
})

// Credential-shape parity: the config predicate that REJECTS credential-shaped keys
// must agree with the shell leak-scanners' shared CRED pattern (scripts/cred-pattern.sh),
// so a shape the config refuses is a shape the publish/credscan gates catch, and vice
// versa. This enforces the TS<->POSIX mirror mechanically instead of by comment.
describe('credential-shape parity (config predicate ↔ shell leak-scan pattern)', () => {
  const shell = readFileSync('scripts/cred-pattern.sh', 'utf8')
  const pattern = shell.match(/CRED='([^']*)'/)?.[1]
  if (pattern === undefined) throw new Error('could not extract CRED from scripts/cred-pattern.sh')
  const bashPattern = new RegExp(pattern) // POSIX ERE features only → equivalent under JS RegExp

  // The two credential-shaped cases are assembled from parts, not written as
  // contiguous literals — a real pat-<uuid> / PEM header in src/ would trip credscan
  // (same convention as the reject-fixture above). They are full credential shapes
  // only at runtime, which is what the parity assertion needs.
  const patShape = ['pat-na1', '0f2e4c6a', '1b3d', '5e7f', '9a0b', 'c1d2e3f4a5b6'].join('-')
  const pemHeader = ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ')
  const cases = [
    patShape, // real PAT shape → credential
    pemHeader, // PEM header → credential
    'PORTAL_A', // plain key → not
    'pat-na1-SECRET', // tokenish fixture, no uuid → not
    'pat-na1-abc123', // tokenish fixture, no uuid → not
    'example.com', // → not
    '123456789', // hub-id placeholder → not
    'a normal label', // → not
  ]
  for (const s of cases) {
    it(`agrees on "${s}"`, () => {
      expect(looksLikeCredential(s)).toBe(bashPattern.test(s))
    })
  }
})

describe('a parked portal cannot also be writable (#87)', () => {
  const portal = {
    tokenEnv: 'A',
    expectedHubId: 111,
    label: 'Example Co A',
    allowedObjects: ['notes'],
    allowedOperations: ['create'],
  }
  const load = (extra: Record<string, unknown>) =>
    loadConfig(
      new FakeConfigProvider({
        portals: { PORTAL_A: { ...portal, ...extra } },
        writeMode: 'propose',
      }),
    )

  it('refuses allowRead=false with allowWrite=true', () => {
    // allowRead is enforced only in ReadService, while the write lifecycle reads
    // target records through preflight — and inspect_plan_target is model-callable on a
    // merely validated plan, before approval. So the combination looked like parking
    // and still disclosed records.
    expect(() => load({ allowRead: false, allowWrite: true })).toThrow(/allowRead=false/)
  })

  it('allows a parked read-only portal', () => {
    expect(() => load({ allowRead: false, allowWrite: false })).not.toThrow()
  })

  it('allows a writable readable portal, which is the normal case', () => {
    expect(() => load({ allowRead: true, allowWrite: true })).not.toThrow()
  })
})

describe('per-portal writeMode (#86)', () => {
  const portal = {
    tokenEnv: 'A',
    expectedHubId: 111,
    label: 'Example Co A',
    allowWrite: true,
    allowedObjects: ['notes'],
    allowedOperations: ['create'],
  }

  it('accepts writeMode on a portal, which AR-3 rules and strict() used to refuse', () => {
    const cfg = loadConfig(
      new FakeConfigProvider({
        portals: { PORTAL_A: { ...portal, writeMode: 'propose' } },
        writeMode: 'apply',
      }),
    )
    expect(cfg.portals.PORTAL_A?.writeMode).toBe('propose')
    expect(cfg.writeMode).toBe('apply')
  })

  it('leaves it undefined when unset, so an existing config inherits the default', () => {
    const cfg = loadConfig(
      new FakeConfigProvider({ portals: { PORTAL_A: portal }, writeMode: 'propose' }),
    )
    expect(cfg.portals.PORTAL_A?.writeMode).toBeUndefined()
  })

  it('still refuses an unknown value', () => {
    expect(() =>
      loadConfig(
        new FakeConfigProvider({
          portals: { PORTAL_A: { ...portal, writeMode: 'yolo' } },
          writeMode: 'propose',
        }),
      ),
    ).toThrow()
  })
})

describe('dead and documented config surface', () => {
  const portal = {
    tokenEnv: 'A',
    expectedHubId: 111,
    label: 'Example Co A',
    allowWrite: false,
  }
  const load = (extra: Record<string, unknown>) =>
    loadConfig(
      new FakeConfigProvider({
        portals: { PORTAL_A: { ...portal, ...extra } },
        writeMode: 'propose',
      }),
    )

  it('refuses defaultCurrency, which was accepted and read nowhere (#92)', () => {
    // The schema declared it, no code read it, and no document mentioned it, so an
    // operator could set it and get silence. Removed rather than documented.
    expect(() => load({ defaultCurrency: 'CAD' })).toThrow()
  })

  it('refuses a label containing a zero-width joiner, as the docs now say', () => {
    // A joined emoji (profession, flag, family) is a ZWJ sequence, which the label
    // rule rejects. USAGE used to invite emoji without qualification.
    expect(() => load({ label: 'Ops \u{1F468}\u200D\u{1F4BB}' })).toThrow()
    expect(() => load({ label: 'Ops \u{1F600}' })).not.toThrow()
  })
})
