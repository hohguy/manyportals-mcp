import { readFileSync } from 'node:fs'
import { SafeError } from '../errors/index.js'
import { looksLikeCredential, redactKey } from './credential-shape.js'
import { configSchema, type ManyPortalsConfig, type PortalConfig } from './schema.js'

export * from './schema.js'
export * from './vault.js'
export * from './credential-shape.js'

/**
 * Source-agnostic config source. Lets config come from env, a file, or (later)
 * an encrypted store without the rest of the app caring where it came from.
 */
export interface ConfigProvider {
  /** Return the raw, unvalidated config object. */
  read(): unknown
}

/** In-memory provider for tests and fixtures. */
export class FakeConfigProvider implements ConfigProvider {
  constructor(private readonly raw: unknown) {}
  read(): unknown {
    return this.raw
  }
}

/**
 * Reads the non-secret portal map from a JSON file on disk. Tokens are NOT in
 * this file — token values are resolved at use time from a `TokenSource` (env
 * vars and/or a separate token file). Errors name the path only, never file
 * contents. The file reader is injectable for tests.
 */
export class FileConfigProvider implements ConfigProvider {
  constructor(
    private readonly path: string,
    private readonly readText: (path: string) => string = (p) => readFileSync(p, 'utf8'),
  ) {}

  read(): unknown {
    let text: string
    try {
      text = this.readText(this.path)
    } catch {
      throw new ConfigError(`config file not found or unreadable: ${this.path}`)
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new ConfigError(`config file is not valid JSON: ${this.path}`)
    }
  }
}

export class ConfigError extends SafeError {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * Parse + validate config from a provider. Throws `ConfigError` with a readable
 * summary of every validation issue. This object carries no tokens, so it is
 * safe to surface in errors.
 */
export function loadConfig(provider: ConfigProvider): ManyPortalsConfig {
  const parsed = configSchema.safeParse(provider.read())
  if (!parsed.success) {
    // Config errors are SafeError-surfaceable (model / audit / doctor / startup), so
    // they must NEVER echo an operator-pasted secret. Two channels can carry one and
    // both are redacted (R4.3): (a) a map KEY in the issue PATH — above all a portal
    // key, when a token is fat-pasted where a short key belongs — and (b) an issue
    // MESSAGE that embeds the input VALUE (e.g. an enum mismatch echoing what was
    // received). Portal keys can't be distinguished from a pasted secret, so every
    // segment under `portals` is redacted; only issue codes whose message is purely
    // schema-descriptive keep their message.
    const safePath = (path: readonly PropertyKey[]): string =>
      path
        .map((seg, idx) => (idx > 0 && path[idx - 1] === 'portals' ? '<portalKey>' : String(seg)))
        .join('.') || '(root)'
    // Zod messages describe the SCHEMA (types, patterns, constraints, author custom
    // messages) — none echo the input VALUE — EXCEPT a literal/enum mismatch, whose
    // message echoes what was received. Redact only that code so a token pasted as an
    // enum value (e.g. writeMode) can't leak, while keeping every helpful message.
    const VALUE_ECHOING_CODES = new Set(['invalid_value', 'invalid_enum_value', 'invalid_literal'])
    const issues = parsed.error.issues
      .map((i) => {
        const at = safePath(i.path)
        if (i.code === 'unrecognized_keys') {
          const n = (i as { keys?: unknown[] }).keys?.length ?? 0
          return `${at}: ${n} unrecognized key(s) present (names redacted — a token or secret must never be a config key)`
        }
        const msg = VALUE_ECHOING_CODES.has(i.code) ? `invalid value (${i.code})` : i.message
        return `${at}: ${msg}`
      })
      .join('; ')
    throw new ConfigError(`invalid ManyPortals config: ${issues}`)
  }
  const config = parsed.data
  // RT-10a: reject a token/secret pasted as a portal KEY or LABEL (the grammar
  // allows any script, so a `pat-`/PEM value passes it). Redacted — never echoed.
  for (const [key, portal] of Object.entries(config.portals)) {
    if (looksLikeCredential(key)) {
      throw new ConfigError('a portal key must not be a token or secret (value redacted)')
    }
    if (looksLikeCredential(portal.label)) {
      throw new ConfigError('a portal label must not be a token or secret (value redacted)')
    }
  }
  // NFC-normalize keys so composed vs decomposed forms of the same name cannot
  // diverge, and refuse a collision. Null-proto so a "toString"/"__proto__" key is
  // a real own entry (RT-06).
  const portals = Object.create(null) as Record<string, PortalConfig>
  for (const [key, portal] of Object.entries(config.portals)) {
    const nk = key.normalize('NFC')
    if (Object.hasOwn(portals, nk)) {
      throw new ConfigError('two portal keys collide after Unicode normalization (values redacted)')
    }
    portals[nk] = portal
  }
  return { ...config, portals }
}

/**
 * A source of per-portal private-app tokens. Returns the token, or `undefined`
 * if this source doesn't have one for the portal. Token VALUES never appear in
 * errors or logs — only portal keys / env var names do.
 */
export interface TokenSource {
  get(portalKey: string, portal: PortalConfig): string | undefined
}

/** Tokens from environment variables named by each portal's `tokenEnv`. */
export class EnvTokenSource implements TokenSource {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  get(_portalKey: string, portal: PortalConfig): string | undefined {
    if (portal.tokenEnv === undefined) return undefined
    // Prototype-safe: `process.env['toString']` returns the inherited FUNCTION,
    // not an env var — a `typeof string` guard prevents a `.trim()` TypeError.
    const v = this.env[portal.tokenEnv]
    return typeof v === 'string' && v.trim() !== '' ? v : undefined
  }
}

/**
 * Tokens from a single portalKey → token map — e.g. one gitignored `tokens.json`
 * file. Lets an operator manage many portals' tokens in one place instead of N
 * environment variables.
 */
export class MapTokenSource implements TokenSource {
  constructor(private readonly map: Readonly<Record<string, string>>) {}
  get(portalKey: string): string | undefined {
    // Prototype-safe: a portal keyed like an `Object.prototype` member
    // (`toString`, `constructor`, …) must not return the inherited function; a
    // `typeof string` guard yields `undefined` for any inherited/non-string member.
    const v = this.map[portalKey]
    return typeof v === 'string' && v.trim() !== '' ? v : undefined
  }
}

/**
 * Read a portalKey → token JSON map from disk. A missing file yields an empty
 * map (no file-backed tokens — env-only still works). Errors name the path only,
 * never any token material. The reader is injectable for tests.
 */
export function readTokenFile(
  path: string,
  readText: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): Record<string, string> {
  let text: string
  try {
    text = readText(path)
  } catch (e) {
    // A truly ABSENT file → no file-backed tokens (the other sources still work).
    // Any OTHER read failure (EACCES, EISDIR, I/O) must fail LOUD, not look
    // "absent": a silent {} would drop this token source and downgrade custody —
    // the fail-open pattern fixed in the JSONL store, swept to its siblings.
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return {}
    throw new ConfigError(
      `token file exists but could not be read (${code ?? 'read error'}): ${path}`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ConfigError(`token file is not valid JSON: ${path}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`token file must be a JSON object of "portalKey": "token": ${path}`)
  }
  // Null-prototype: a portal keyed "__proto__"/"toString" becomes a REAL own
  // entry (a plain {} would route "__proto__" to the prototype setter and drop
  // that portal's token silently).
  const out = Object.create(null) as Record<string, string>
  for (const [k, v] of Object.entries(parsed)) {
    // Checked BEFORE the value, because the value check interpolates the key. A
    // credential-shaped key means the file is written the wrong way round, so this
    // refuses rather than redacting and carrying on with a token as a portal key
    // (#74, #75). The message names neither the key nor any part of it.
    if (looksLikeCredential(k)) {
      throw new ConfigError(
        `token file has a KEY shaped like a credential, so it is probably inverted: ` +
          `it must map "portalKey" to "token", not the other way round: ${path}`,
      )
    }
    if (typeof v !== 'string') {
      throw new ConfigError(`token file value for "${redactKey(k)}" must be a string: ${path}`)
    }
    out[k] = v
  }
  return out
}

/**
 * Compose token sources into a resolver (first source that has the token wins).
 * Throws `ConfigError` — naming the portal + how to provide a token, never the
 * token itself — when no source has one.
 */
export function createTokenResolver(
  sources: TokenSource[],
): (portalKey: string, portal: PortalConfig) => string {
  return (portalKey, portal) => {
    for (const s of sources) {
      const t = s.get(portalKey, portal)
      if (t !== undefined) return t
    }
    const where = portal.tokenEnv ? `env var ${portal.tokenEnv}, or ` : ''
    throw new ConfigError(
      `no token for portal "${portalKey}": set ${where}an entry in the token file`,
    )
  }
}
