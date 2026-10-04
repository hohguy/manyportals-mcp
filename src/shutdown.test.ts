import { describe, it, expect, vi, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync, chmodSync, mkdtempSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installShutdown } from './index.js'

/**
 * Clean shutdown on a signal (#157).
 *
 * The ticket's premise was that the server relies on the host to kill it. Measuring
 * first showed otherwise: it already exits code=0 on stdin EOF, which is the path
 * Claude Desktop uses. What was missing is signal handling, where it died by the
 * default disposition, so a supervisor recorded it as killed and nothing reported that
 * it was going away.
 *
 * These assert BEHAVIOUR, not that a handler exists, because "a handler is installed"
 * is exactly the claim that stays true while the shutdown it performs is broken.
 */
afterEach(() => {
  process.removeAllListeners('SIGTERM')
  process.removeAllListeners('SIGINT')
  vi.useRealTimers()
})

function harness(close: () => Promise<void>, timeoutMs = 2000) {
  const codes: number[] = []
  const lines: string[] = []
  installShutdown(
    close,
    (c) => codes.push(c),
    (s) => lines.push(s),
    timeoutMs,
  )
  return { codes, lines }
}

describe('installShutdown', () => {
  it('closes and exits 0 on SIGTERM', async () => {
    let closed = 0
    const h = harness(async () => {
      closed++
    })
    process.emit('SIGTERM')
    await vi.waitFor(() => expect(h.codes).toEqual([0]))
    expect(closed).toBe(1)
    expect(h.lines.join('')).toContain('shut down cleanly')
  })

  it('closes and exits 0 on SIGINT', async () => {
    const h = harness(async () => {})
    process.emit('SIGINT')
    await vi.waitFor(() => expect(h.codes).toEqual([0]))
    expect(h.lines.join('')).toContain('SIGINT')
  })

  it('exits non-zero when close rejects, without printing the reason', async () => {
    // A close failure can carry a path or a response body, and this message lands in
    // the operator's logs unsanitized, so the reason must not be interpolated.
    const h = harness(async () => {
      throw new Error('vault at /Users/someone/.manyportals/tokens.vault is locked')
    })
    process.emit('SIGTERM')
    await vi.waitFor(() => expect(h.codes).toEqual([1]))
    const out = h.lines.join('')
    expect(out).toContain('close failed')
    expect(out).not.toContain('tokens.vault')
    expect(out).not.toContain('/Users/')
  })

  it('exits anyway when close hangs, rather than looking shut down forever', async () => {
    // THE POINT OF THE TIMEOUT. A close that never resolves would otherwise leave a
    // process holding portal tokens and the vault passphrase alive indefinitely while
    // appearing to have shut down, which is worse than being killed.
    vi.useFakeTimers()
    const h = harness(() => new Promise<void>(() => {}), 2000)
    process.emit('SIGTERM')
    expect(h.codes).toEqual([])
    await vi.advanceTimersByTimeAsync(2001)
    expect(h.codes).toEqual([1])
    expect(h.lines.join('')).toContain('did not finish')
  })

  it('a second signal does not start a second close', async () => {
    let closed = 0
    const h = harness(async () => {
      closed++
    })
    process.emit('SIGTERM')
    process.emit('SIGINT')
    await vi.waitFor(() => expect(h.codes.length).toBeGreaterThan(0))
    expect(closed).toBe(1)
  })
})

/**
 * The spawned-process check, gated on dist/ being present AND CURRENT.
 *
 * `npm run verify` runs the tests BEFORE the build, so dist may be absent or stale.
 * Existence alone is not enough, and that is not hypothetical: these tests first ran
 * against a stale bundle and reported `code=null signal=SIGTERM`, the pre-change
 * behaviour, which looked like the fix had failed. The same staleness in the other
 * direction is worse — a broken handler passing because dist still holds a good
 * build — so a bundle older than the newest source is skipped, not trusted.
 */
const DIST = join(process.cwd(), 'dist', 'index.js')

function newestSourceMtime(dir: string): number {
  let newest = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name)
    if (e.isDirectory()) newest = Math.max(newest, newestSourceMtime(abs))
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
      newest = Math.max(newest, statSync(abs).mtimeMs)
  }
  return newest
}

const distIsCurrent =
  existsSync(DIST) && statSync(DIST).mtimeMs >= newestSourceMtime(join(process.cwd(), 'src'))

describe.skipIf(!distIsCurrent)('a spawned server exits on each trigger', () => {
  function fixture(): string {
    const d = mkdtempSync(join(tmpdir(), 'mp-shutdown-'))
    // expectedHubId 0 means "unknown", so assertHubIds SKIPS its live call and this
    // starts with no network at all. A test must never reach api.hubapi.com.
    writeFileSync(
      join(d, 'config.json'),
      JSON.stringify({
        portals: { PORTAL_A: { expectedHubId: 0, label: 'Example Co', allowWrite: false } },
      }),
    )
    writeFileSync(join(d, 'tokens.json'), JSON.stringify({ PORTAL_A: `pat-${'0'.repeat(4)}` }))
    chmodSync(join(d, 'tokens.json'), 0o600)
    return d
  }

  /**
   * Wait until the server is actually serving, rather than guessing a delay.
   *
   * The first version slept 800ms and then signalled. That passed locally and FAILED in
   * the staged public tree, where `npm ci` and the rest of verify were competing for the
   * machine: `code=null signal=SIGTERM` means the process was alive with no handler yet,
   * so the signal hit the default disposition. A timer is not a readiness check, it is a
   * bet on load, and L12's rule applies to my own tests.
   *
   * `installShutdown` is called immediately after `startServer` resolves, and
   * `startServer` resolves once the transport is connected. So a reply to `initialize`
   * is proof the handler is installed, which is the property the delay was standing in
   * for.
   */
  function awaitReady(p: ReturnType<typeof spawn>): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server did not answer initialize')), 6000)
      let buf = ''
      p.stdout?.on('data', (d: Buffer) => {
        buf += d.toString()
        if (buf.includes('"result"')) {
          clearTimeout(t)
          resolve()
        }
      })
      p.stdin?.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'shutdown-test', version: '0' },
          },
        }) + '\n',
      )
    })
  }

  function run(act: (p: ReturnType<typeof spawn>) => void): Promise<string> {
    const d = fixture()
    return new Promise((resolve) => {
      const p = spawn('node', [DIST], {
        env: {
          ...process.env,
          MANYPORTALS_CONFIG: join(d, 'config.json'),
          MANYPORTALS_TOKENS_FILE: join(d, 'tokens.json'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let settled = false
      const t = setTimeout(() => {
        if (!settled) {
          settled = true
          p.kill('SIGKILL')
          resolve('DID NOT EXIT')
        }
      }, 8000)
      p.on('exit', (code, signal) => {
        if (!settled) {
          settled = true
          clearTimeout(t)
          resolve(`code=${code} signal=${signal}`)
        }
      })
      // Signal only once it is demonstrably serving. A failure to become ready resolves
      // with its own message rather than timing out opaquely.
      awaitReady(p).then(
        () => act(p),
        (e: Error) => {
          if (!settled) {
            settled = true
            clearTimeout(t)
            p.kill('SIGKILL')
            resolve(`NOT READY: ${e.message}`)
          }
        },
      )
    })
  }

  it('exits 0 when stdin closes', async () => {
    // Already true before #157: the SDK's stdio transport ends the process on EOF.
    // Pinned so a future SDK bump cannot take it away quietly.
    expect(await run((p) => p.stdin?.end())).toBe('code=0 signal=null')
  }, 15000)

  it('exits 0 on SIGTERM rather than dying by signal', async () => {
    // Was `code=null signal=SIGTERM` before this change.
    expect(await run((p) => p.kill('SIGTERM'))).toBe('code=0 signal=null')
  }, 15000)

  it('exits 0 on SIGINT rather than dying by signal', async () => {
    expect(await run((p) => p.kill('SIGINT'))).toBe('code=0 signal=null')
  }, 15000)
})
