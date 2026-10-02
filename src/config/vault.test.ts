import { describe, it, expect } from 'vitest'
import {
  EnvTokenSource,
  MapTokenSource,
  VaultError,
  createTokenResolver,
  decryptVaultTokens,
  encryptVaultTokens,
  readVaultFile,
  vaultWithToken,
  vaultWithoutToken,
  type PortalConfig,
  type TokenSource,
} from './index.js'

const TOKENS = { PORTAL_A: 'pat-na1-SECRET-A', PORTAL_B: 'pat-eu1-SECRET-B' }
const PASS = 'correct horse battery staple'

describe('vault encrypt/decrypt round trip', () => {
  it('round-trips the token map under the right passphrase', () => {
    const envelope = encryptVaultTokens(TOKENS, PASS)
    expect(decryptVaultTokens(envelope, PASS)).toEqual(TOKENS)
  })

  it('the envelope never contains token material or the passphrase in the clear', () => {
    const envelope = encryptVaultTokens(TOKENS, PASS)
    expect(envelope).not.toContain('pat-')
    expect(envelope).not.toContain('SECRET')
    expect(envelope).not.toContain('PORTAL_A') // even portal keys are inside the ciphertext
    expect(envelope).not.toContain(PASS)
  })

  it('two encryptions of the same input differ (fresh salt + IV each time)', () => {
    expect(encryptVaultTokens(TOKENS, PASS)).not.toEqual(encryptVaultTokens(TOKENS, PASS))
  })

  it('refuses an empty passphrase', () => {
    expect(() => encryptVaultTokens(TOKENS, '  ')).toThrow(VaultError)
  })
})

describe('vault decryption failure posture (sanitized, fail closed)', () => {
  it('wrong passphrase → VaultError with no token material in the message', () => {
    const envelope = encryptVaultTokens(TOKENS, PASS)
    let caught: unknown
    try {
      decryptVaultTokens(envelope, 'wrong-passphrase')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(VaultError)
    expect((caught as Error).message).not.toContain('pat-')
    expect((caught as Error).message).not.toContain('SECRET')
  })

  it('tampered ciphertext or auth tag → VaultError (GCM integrity)', () => {
    const envelope = JSON.parse(encryptVaultTokens(TOKENS, PASS)) as Record<string, string>
    const flip = (b64: string): string => {
      const buf = Buffer.from(b64, 'base64')
      buf[0] = buf[0]! ^ 0xff
      return buf.toString('base64')
    }
    const tamperedCiphertext = JSON.stringify({
      ...envelope,
      ciphertext: flip(envelope.ciphertext!),
    })
    expect(() => decryptVaultTokens(tamperedCiphertext, PASS)).toThrow(VaultError)
    const tamperedTag = JSON.stringify({ ...envelope, tag: flip(envelope.tag!) })
    expect(() => decryptVaultTokens(tamperedTag, PASS)).toThrow(VaultError)
  })

  it('non-JSON, missing fields, and unsupported versions are rejected as vault defects', () => {
    expect(() => decryptVaultTokens('not json at all', PASS)).toThrow(VaultError)
    expect(() => decryptVaultTokens('{"version":1}', PASS)).toThrow(/malformed/)
    const envelope = JSON.parse(encryptVaultTokens(TOKENS, PASS)) as Record<string, unknown>
    expect(() => decryptVaultTokens(JSON.stringify({ ...envelope, version: 99 }), PASS)).toThrow(
      /unsupported vault version/,
    )
  })
})

describe('readVaultFile', () => {
  it('an absent file yields an empty map (env/plaintext sources still work)', () => {
    expect(
      readVaultFile('/nope/tokens.vault', PASS, () => {
        const e = new Error('ENOENT') as NodeJS.ErrnoException
        e.code = 'ENOENT'
        throw e
      }),
    ).toEqual({})
  })

  it('FAILS LOUD on a non-ENOENT read error — no silent downgrade to plaintext', () => {
    expect(() =>
      readVaultFile('/x/tokens.vault', PASS, () => {
        const e = new Error('EISDIR') as NodeJS.ErrnoException
        e.code = 'EISDIR'
        throw e
      }),
    ).toThrow(/could not be read/)
  })

  it('a present file decrypts through the injected reader', () => {
    const envelope = encryptVaultTokens(TOKENS, PASS)
    expect(readVaultFile('/x/tokens.vault', PASS, () => envelope)).toEqual(TOKENS)
  })
})

describe('vault add/remove one token (#23)', () => {
  const open = (envelope: string): Record<string, string> => decryptVaultTokens(envelope, PASS)

  it('adds a key to an existing vault, keeping every other token', () => {
    const { envelope, replaced } = vaultWithToken(
      encryptVaultTokens(TOKENS, PASS),
      PASS,
      'PORTAL_C',
      'pat-ap1-SECRET-C',
    )
    expect(replaced).toBe(false)
    expect(open(envelope)).toEqual({ ...TOKENS, PORTAL_C: 'pat-ap1-SECRET-C' })
  })

  it('replaces an existing key and says so', () => {
    const { envelope, replaced } = vaultWithToken(
      encryptVaultTokens(TOKENS, PASS),
      PASS,
      'PORTAL_A',
      'pat-na1-SECRET-A2',
    )
    expect(replaced).toBe(true)
    expect(open(envelope)).toEqual({ PORTAL_A: 'pat-na1-SECRET-A2', PORTAL_B: TOKENS.PORTAL_B })
  })

  it('creates a vault when there is none yet', () => {
    const { envelope, replaced } = vaultWithToken(undefined, PASS, 'PORTAL_A', 'pat-na1-SECRET-A')
    expect(replaced).toBe(false)
    expect(open(envelope)).toEqual({ PORTAL_A: 'pat-na1-SECRET-A' })
  })

  it('stores the token trimmed (a paste often carries a trailing newline)', () => {
    const { envelope } = vaultWithToken(undefined, PASS, 'PORTAL_A', '  pat-na1-SECRET-A\n')
    expect(open(envelope)).toEqual({ PORTAL_A: 'pat-na1-SECRET-A' })
  })

  it('refuses an empty or whitespace-only portal key or token', () => {
    const envelope = encryptVaultTokens(TOKENS, PASS)
    expect(() => vaultWithToken(envelope, PASS, '', 'pat-x')).toThrow(VaultError)
    expect(() => vaultWithToken(envelope, PASS, '  ', 'pat-x')).toThrow(VaultError)
    expect(() => vaultWithToken(envelope, PASS, 'PORTAL_C', '')).toThrow(VaultError)
    expect(() => vaultWithToken(undefined, PASS, 'PORTAL_C', ' \n')).toThrow(VaultError)
  })

  it('removes a key, keeping every other token; removing the last one leaves an empty vault', () => {
    const withoutB = vaultWithoutToken(encryptVaultTokens(TOKENS, PASS), PASS, 'PORTAL_B')
    expect(open(withoutB)).toEqual({ PORTAL_A: TOKENS.PORTAL_A })
    expect(open(vaultWithoutToken(withoutB, PASS, 'PORTAL_A'))).toEqual({})
  })

  it('removing a key that is not in the vault throws, naming no token', () => {
    const envelope = encryptVaultTokens(TOKENS, PASS)
    expect(() => vaultWithoutToken(envelope, PASS, 'PORTAL_C')).toThrow(VaultError)
    expect(() => vaultWithoutToken(envelope, PASS, 'PORTAL_C')).toThrow(/not in the vault/)
    // A prototype name is not "present" just because a plain object would inherit it.
    expect(() => vaultWithoutToken(envelope, PASS, 'toString')).toThrow(/not in the vault/)
  })

  it('a wrong passphrase throws the sanitized decryption error from both functions', () => {
    const envelope = encryptVaultTokens(TOKENS, PASS)
    const failures = [
      () => vaultWithToken(envelope, 'wrong-passphrase', 'PORTAL_C', 'pat-ap1-SECRET-C'),
      () => vaultWithoutToken(envelope, 'wrong-passphrase', 'PORTAL_B'),
    ]
    for (const attempt of failures) {
      let caught: unknown
      try {
        attempt()
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(VaultError)
      const message = (caught as Error).message
      expect(message).toMatch(/decryption failed/)
      expect(message).not.toContain('SECRET')
      expect(message).not.toContain('wrong-passphrase')
    }
  })

  it('a "__proto__" portal key survives add and can be removed; "toString" is a real new key', () => {
    // From no vault AND from an existing one: both map-building paths must be null-prototype.
    const created = vaultWithToken(undefined, PASS, '__proto__', 'fake-proto-token')
    expect(Object.hasOwn(open(created.envelope), '__proto__')).toBe(true)
    expect(open(created.envelope)['__proto__']).toBe('fake-proto-token')

    const added = vaultWithToken(
      encryptVaultTokens(TOKENS, PASS),
      PASS,
      '__proto__',
      'fake-proto-token',
    )
    expect(added.replaced).toBe(false)
    expect(Object.keys(open(added.envelope)).sort()).toEqual(['PORTAL_A', 'PORTAL_B', '__proto__'])
    expect(open(added.envelope)['__proto__']).toBe('fake-proto-token')

    const withToString = vaultWithToken(added.envelope, PASS, 'toString', 'fake-tostring-token')
    expect(withToString.replaced).toBe(false)

    // Removing ANOTHER key rebuilds the map: "__proto__" must survive that too.
    const keptProto = open(vaultWithoutToken(withToString.envelope, PASS, 'PORTAL_B'))
    expect(Object.keys(keptProto).sort()).toEqual(['PORTAL_A', '__proto__', 'toString'])
    expect(keptProto['__proto__']).toBe('fake-proto-token')

    const removed = vaultWithoutToken(withToString.envelope, PASS, '__proto__')
    expect(Object.hasOwn(open(removed), '__proto__')).toBe(false)
    expect(Object.keys(open(removed)).sort()).toEqual(['PORTAL_A', 'PORTAL_B', 'toString'])
  })

  it('a vault written by encryptVaultTokens opens with both new functions', () => {
    const legacy = encryptVaultTokens(TOKENS, PASS)
    expect(open(vaultWithToken(legacy, PASS, 'PORTAL_B', TOKENS.PORTAL_B).envelope)).toEqual(TOKENS)
    expect(open(vaultWithoutToken(legacy, PASS, 'PORTAL_A'))).toEqual({ PORTAL_B: TOKENS.PORTAL_B })
  })
})

describe('token-source chain precedence with a vault (env → vault → plaintext file)', () => {
  const portal = (tokenEnv?: string): PortalConfig =>
    ({ tokenEnv, expectedHubId: 1, label: 'P', apiHost: 'api.hubapi.com' }) as PortalConfig

  it('env wins over vault; vault wins over the plaintext file', () => {
    const env: TokenSource = new EnvTokenSource({ TOK_A: 'from-env' })
    const vault: TokenSource = new MapTokenSource(
      decryptVaultTokens(
        encryptVaultTokens({ PORTAL_A: 'from-vault', PORTAL_B: 'from-vault' }, PASS),
        PASS,
      ),
    )
    const file: TokenSource = new MapTokenSource({
      PORTAL_A: 'from-file',
      PORTAL_B: 'from-file',
      PORTAL_C: 'from-file',
    })
    const resolve = createTokenResolver([env, vault, file])
    expect(resolve('PORTAL_A', portal('TOK_A'))).toBe('from-env') // env beats vault
    expect(resolve('PORTAL_B', portal())).toBe('from-vault') // vault beats file
    expect(resolve('PORTAL_C', portal())).toBe('from-file') // file still works
  })
})
