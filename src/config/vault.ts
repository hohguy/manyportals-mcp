import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { SafeError } from '../errors/index.js'
import { looksLikeCredential, redactKey } from './credential-shape.js'

/**
 * Encrypted token vault (the pulled-forward vault milestone, 2026-07-06).
 *
 * At-rest encryption for the portalKey → token map: AES-256-GCM with a key
 * derived from a master passphrase via scrypt (node:crypto only — no new
 * dependency, per the standing credential-model decision). The passphrase
 * reaches the server as `MANYPORTALS_VAULT_KEY` — set manually, or entered in the
 * Claude Desktop bundle's settings (a `sensitive` user-config field) and passed as
 * env at launch. How Desktop protects that stored value is NEEDS_VERIFICATION, so do
 * not describe it as keychain-held. The Local MCP servers screen showed the value in
 * plain text when checked on 2026-09-15 and showed it MASKED on 2026-10-06 on version
 * 2.26454.0 for macOS, so neither observation is current on its own — treat that screen
 * as sensitive and cite the client and version (#52, #269). Masking there changes
 * nothing about the environment-variable exposure, which is #251.
 *
 * Failure posture: ANY decrypt/parse problem collapses to a single sanitized
 * `VaultError` — never the underlying error, which could echo file contents.
 * Token values and the passphrase never appear in errors, logs, or output.
 *
 * Envelope (JSON, version-gated so params can evolve):
 *   { version: 1, kdf: 'scrypt', salt, iv, tag, ciphertext }   // base64 fields
 * Version 1 pins scrypt N=16384, r=8, p=1, 32-byte key, 12-byte IV, GCM.
 */
export class VaultError extends SafeError {
  constructor(message: string) {
    super(message)
    this.name = 'VaultError'
  }
}

const VAULT_VERSION = 1
const KEY_BYTES = 32
const IV_BYTES = 12
const SALT_BYTES = 16
/** Version-1 scrypt cost parameters (Node defaults; ~50ms — fine for one boot-time derive). */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 }

interface VaultEnvelope {
  version: number
  kdf: string
  salt: string
  iv: string
  tag: string
  ciphertext: string
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_BYTES, SCRYPT_PARAMS)
}

/** Encrypt a portalKey → token map under a master passphrase; returns the envelope JSON. */
export function encryptVaultTokens(
  tokens: Readonly<Record<string, string>>,
  passphrase: string,
): string {
  if (passphrase.trim() === '') {
    throw new VaultError('vault passphrase must not be empty')
  }
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)
  const plaintext = Buffer.from(JSON.stringify(tokens), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const envelope: VaultEnvelope = {
    version: VAULT_VERSION,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
  return JSON.stringify(envelope)
}

/** Parse + shape-check the envelope. Throws `VaultError` naming the defect, never contents. */
function parseEnvelope(envelopeJson: string): VaultEnvelope {
  let parsed: unknown
  try {
    parsed = JSON.parse(envelopeJson)
  } catch {
    throw new VaultError('vault file is not valid JSON (not a vault, or corrupted)')
  }
  const e = parsed as Partial<VaultEnvelope> | null
  if (
    e === null ||
    typeof e !== 'object' ||
    typeof e.version !== 'number' ||
    typeof e.kdf !== 'string' ||
    typeof e.salt !== 'string' ||
    typeof e.iv !== 'string' ||
    typeof e.tag !== 'string' ||
    typeof e.ciphertext !== 'string'
  ) {
    throw new VaultError('vault file is malformed (missing envelope fields)')
  }
  if (e.version !== VAULT_VERSION || e.kdf !== 'scrypt') {
    // Do NOT interpolate e.kdf — it is unvalidated file content (sanitization
    // discipline: never echo untrusted contents into an error). The version is
    // a typed number and safe to name.
    throw new VaultError(
      `unsupported vault version (${e.version}) or kdf — this build supports version ${VAULT_VERSION}/scrypt`,
    )
  }
  return e as VaultEnvelope
}

/**
 * Decrypt an envelope back to the portalKey → token map. A wrong passphrase,
 * tampered ciphertext, or malformed payload all yield the same sanitized
 * `VaultError` class — GCM's auth tag makes tampering indistinguishable from a
 * wrong key by design.
 */
export function decryptVaultTokens(
  envelopeJson: string,
  passphrase: string,
): Record<string, string> {
  const envelope = parseEnvelope(envelopeJson)
  let plaintext: Buffer
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      deriveKey(passphrase, Buffer.from(envelope.salt, 'base64')),
      Buffer.from(envelope.iv, 'base64'),
    )
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ])
  } catch {
    // Never surface the underlying crypto error.
    throw new VaultError('vault decryption failed — wrong passphrase, or the vault was modified')
  }
  let tokens: unknown
  try {
    tokens = JSON.parse(plaintext.toString('utf8'))
  } catch {
    throw new VaultError('vault contents are malformed')
  }
  // Mirror readTokenFile's shape rules: a flat object of string → string.
  if (tokens === null || typeof tokens !== 'object' || Array.isArray(tokens)) {
    throw new VaultError('vault contents must be an object of "portalKey": "token"')
  }
  // Null-prototype (mirrors readTokenFile): a "__proto__"/"toString" portal key
  // is a real own entry, not routed to the prototype setter and dropped.
  const out = Object.create(null) as Record<string, string>
  for (const [k, v] of Object.entries(tokens)) {
    // Mirrors readTokenFile: a credential-shaped key is an inverted map, and the
    // value error below would otherwise interpolate it (#74, #75).
    if (looksLikeCredential(k)) {
      throw new VaultError(
        'the vault has a KEY shaped like a credential, so it is probably inverted: ' +
          'it must map "portalKey" to "token", not the other way round',
      )
    }
    if (typeof v !== 'string') {
      throw new VaultError(`vault token value for "${redactKey(k)}" must be a string`)
    }
    out[k] = v
  }
  return out
}

/**
 * Add or replace ONE portal's token (#23): decrypt the envelope — or start empty
 * when there is no vault yet — set the key, and re-encrypt under the same
 * passphrase. `replaced` says whether the key was already there. A wrong
 * passphrase throws the sanitized decryption `VaultError` and yields nothing.
 *
 * The token is stored TRIMMED: a pasted token often carries a trailing newline or
 * space that is not part of the token.
 */
export function vaultWithToken(
  envelope: string | undefined,
  passphrase: string,
  portalKey: string,
  token: string,
): { envelope: string; replaced: boolean } {
  if (portalKey.trim() === '') {
    throw new VaultError('portal key must not be empty')
  }
  const trimmed = token.trim()
  if (trimmed === '') {
    throw new VaultError(`token for "${portalKey}" must not be empty`)
  }
  // Null-prototype on BOTH paths (decryptVaultTokens returns one): on a plain `{}`
  // a "__proto__" key is routed to the prototype setter and silently dropped.
  const tokens =
    envelope === undefined
      ? (Object.create(null) as Record<string, string>)
      : decryptVaultTokens(envelope, passphrase)
  // Object.hasOwn, not `in`: a "toString" key must not read as already present.
  const replaced = Object.hasOwn(tokens, portalKey)
  tokens[portalKey] = trimmed
  return { envelope: encryptVaultTokens(tokens, passphrase), replaced }
}

/**
 * Remove ONE portal's token (#23): decrypt, drop the key, re-encrypt under the
 * same passphrase. A key that is not in the vault throws rather than writing an
 * unchanged vault; removing the last key leaves a valid empty vault.
 */
export function vaultWithoutToken(envelope: string, passphrase: string, portalKey: string): string {
  const tokens = decryptVaultTokens(envelope, passphrase)
  if (!Object.hasOwn(tokens, portalKey)) {
    throw new VaultError(`portal "${portalKey}" is not in the vault — nothing removed`)
  }
  // Rebuilt null-prototype, so a "__proto__" key that stays is a real entry.
  const remaining = Object.create(null) as Record<string, string>
  for (const [k, v] of Object.entries(tokens)) {
    if (k !== portalKey) remaining[k] = v
  }
  return encryptVaultTokens(remaining, passphrase)
}

/**
 * Read + decrypt a vault file. A missing file yields an empty map (no
 * vault-backed tokens — the other sources still work), mirroring
 * `readTokenFile`. Errors name the path or defect, never token material.
 */
export function readVaultFile(
  path: string,
  passphrase: string,
  readText: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): Record<string, string> {
  let text: string
  try {
    text = readText(path)
  } catch (e) {
    // Missing vault → no vault-backed tokens (mirrors readTokenFile). But an
    // existing vault that cannot be READ (EACCES, EISDIR, I/O) must FAIL LOUD:
    // returning {} would silently downgrade to the plaintext token file despite
    // an active vault key — a credential-custody fail-open.
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return {}
    throw new VaultError(`vault file exists but could not be read (${code ?? 'read error'})`)
  }
  return decryptVaultTokens(text, passphrase)
}
