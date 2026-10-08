import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

  it('closes and exits 0 on SIGHUP, which used to kill it by default disposition', async () => {
    // #214. Added for Windows, where a closing console window is one of the few events
    // that actually reaches a node process — and it fixed a POSIX gap at the same time:
    // a terminal hangup is the same "the host is going away" event as SIGTERM, and it
    // was not handled.
    const h = harness(async () => {})
    process.emit('SIGHUP')
    await vi.waitFor(() => expect(h.codes).toEqual([0]))
    expect(h.lines.join('')).toContain('SIGHUP')
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
 * The spawned-process check, against an artifact THIS FILE owns (#181).
 *
 * It used to spawn the shared `dist/`, gated on that bundle being present and newer
 * than the newest source file. Both halves of that went wrong, in opposite directions.
 * The gate SKIPPED these three cases whenever a source file had been touched since the
 * last build, which is most of the time, so they almost never ran (#167). And when they
 * did run they RACED: `src/index.e2e.test.ts`'s `beforeAll` runs `npm run build`, whose
 * first step deletes `dist`, and vitest runs test FILES in parallel. So a second
 * consecutive `npm run verify` found a current `dist`, ran these cases, and 2 of the 3
 * died in the module loader at ~100ms with `code=1 signal=null` and no server stderr at
 * all: the binary was being deleted while node was reading it.
 *
 * Snapshotting the shared `dist` does NOT fix that, which was tried first: the
 * snapshot's source is the contended resource, so the copy raced the deletion exactly
 * as the spawn did, and it raced it inside a `beforeAll`, which runs even when its
 * describe is skipped. This file builds its own artifact instead and shares nothing.
 * Neither file now cares what the other does, and the three cases run in every suite
 * rather than when the mtimes happen to line up.
 *
 * WHERE it builds matters twice over, both found by spawning a build by hand rather
 * than by reasoning about it:
 *   - Under the repository, not $TMPDIR. Node resolves a bare import by walking
 *     ANCESTOR directories appending `node_modules`, so a build outside this tree never
 *     reaches the real one and the SDK import fails. `node_modules/.cache/` is inside
 *     the tree and is gitignored.
 *   - With `package.json` one level above `dist`. The server reads the manifest
 *     relative to its own location to report its version, and `"type": "module"` is
 *     what makes node parse `dist/*.js` as ESM at all. Without it the child exits
 *     reporting `cannot read the package manifest at ... (ENOENT)`.
 *
 * A build FAILURE is LOUD rather than a skip, because a skip is how the mtime gate hid
 * the missing coverage for so long: `beforeAll` throws with the compiler's own output,
 * which fails these three cases and nothing else.
 */
const OWN = join(process.cwd(), 'node_modules', '.cache', 'mp-shutdown-artifact')
const BIN = join(OWN, 'dist', 'index.js')

describe('a spawned server exits on each trigger', () => {
  beforeAll(() => {
    // A leftover artifact from an earlier run must not be spawned: a source file deleted
    // since then would still be sitting in it, which is the staleness the mtime gate was
    // there to catch.
    rmSync(OWN, { recursive: true, force: true })
    mkdirSync(OWN, { recursive: true })
    try {
      // THROUGH NODE, NOT THROUGH npx (#210). `npx` on Windows is `npx.cmd`, and
      // child_process refuses to execute a .cmd without `shell: true` — the mitigation
      // Node shipped for CVE-2024-27980 — so this failed with `spawnSync npx.cmd EINVAL`
      // and took all three cases below with it. Naming the compiler's own entry point and
      // running it with this process's node removes the shim AND the platform branch,
      // rather than repairing the branch. typescript ships `bin/tsc` as `require(...)`
      // under a node shebang, so there is nothing platform-specific left here.
      execFileSync(
        process.execPath,
        [
          join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc'),
          '-p',
          'tsconfig.build.json',
          '--outDir',
          join(OWN, 'dist'),
        ],
        { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (e) {
      const x = e as { stdout?: string; stderr?: string }
      throw new Error(
        `the artifact build for this file failed, so the spawned-server cases cannot ` +
          `run:\n${x.stdout ?? ''}${x.stderr ?? ''}`,
        // The compiler's output is the diagnosis, and the original error carries the
        // status and the signal; eslint's preserve-caught-error rule is right that
        // dropping it loses the second half.
        { cause: e },
      )
    }
    copyFileSync(join(process.cwd(), 'package.json'), join(OWN, 'package.json'))
  }, 180_000)

  afterAll(() => {
    rmSync(OWN, { recursive: true, force: true })
  })

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
      const p = spawn('node', [BIN], {
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

  /**
   * SKIPPED on Windows (#214), and not because the product is broken there.
   *
   * `p.kill('SIGTERM')` on Windows does not deliver a signal: SIGTERM does not exist on
   * that platform, and `process.kill` force-terminates the target. The same is true of
   * `p.kill('SIGINT')` — a real console Ctrl+C reaches a handler, a `kill` does not. So
   * these two cases report `code=null signal=SIGTERM` on Windows no matter what handlers
   * the child installed, and they cannot prove or disprove anything there.
   *
   * What CAN be proven on Windows is proven: the stdin-EOF case below runs on every
   * platform, and it is the path Claude Desktop actually uses. `installShutdown` also now
   * registers SIGHUP and SIGBREAK, which are what Windows does deliver, and the unit
   * cases above exercise SIGHUP directly rather than through a spawn.
   *
   * These failed loudly rather than silently for one day only, between #210 making them
   * runnable and this gate. That is the right order: a skip added before anyone saw the
   * failure is how #167 hid missing coverage for weeks.
   */
  it.skipIf(process.platform === 'win32')(
    'exits 0 on SIGTERM rather than dying by signal',
    async () => {
      // Was `code=null signal=SIGTERM` before this change.
      expect(await run((p) => p.kill('SIGTERM'))).toBe('code=0 signal=null')
    },
    15000,
  )

  it.skipIf(process.platform === 'win32')(
    'exits 0 on SIGINT rather than dying by signal',
    async () => {
      expect(await run((p) => p.kill('SIGINT'))).toBe('code=0 signal=null')
    },
    15000,
  )
})
