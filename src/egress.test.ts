import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ALLOWED_API_HOSTS } from './config/index.js'

/**
 * Egress allowlist guard (AR-5): the server's only legitimate runtime outbound
 * destination is api.hubapi.com, reached solely through the HubSpot client's
 * injectable `fetchImpl`. These tests fail if (a) the host allowlist is widened,
 * or (b) any runtime source introduces a raw network call / a node networking
 * import — i.e. a second egress path (telemetry, update-phone-home, etc.).
 */
const SRC = join(process.cwd(), 'src')

function runtimeSourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .map((f) => f.split(/[\\/]/).join('/'))
    .filter((f) => f.endsWith('.ts') && !/\.test\.ts$/.test(f))
}

describe('egress allowlist (AR-5)', () => {
  it('the API host allowlist is locked to api.hubapi.com', () => {
    expect([...ALLOWED_API_HOSTS]).toEqual(['api.hubapi.com'])
  })

  it('network egress is confined to the HubSpot client — no other source touches the network', () => {
    // Network egress (fetch/socket call, or a node networking import) is allowed
    // ONLY in the HubSpot client. Any other runtime file matching is a second
    // egress path (telemetry, update-phone-home, etc.) and fails the build.
    const NET =
      /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|from\s*['"]node:(?:http|https|http2|net|tls|dgram|dns)['"]|require\(\s*['"]node:(?:http|https|net)['"]/
    const ALLOWED_EGRESS = new Set(['hubspot/http.ts'])
    // POSITIVE CONTROL first. The only assertion here was that `offenders` is empty,
    // so a NET regex broken by a typo, a rename or an over-escape would pass forever
    // while a second egress path went undetected — the guard between this codebase
    // and a telemetry call, asserted in the one direction that cannot detect its own
    // breakage (#85). Proving the pattern still matches the one file it is allowed to
    // match costs a line.
    expect(NET.test(readFileSync(join(SRC, 'hubspot/http.ts'), 'utf8'))).toBe(true)
    const offenders = runtimeSourceFiles().filter(
      (f) => !ALLOWED_EGRESS.has(f) && NET.test(readFileSync(join(SRC, f), 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})
