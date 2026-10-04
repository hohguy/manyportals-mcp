import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The release gate (#162).
 *
 * #116 carried `wave:publish-gate`, meaning "decide before publishing". The repo went
 * public at v0.1.8 with it unresolved and nothing noticed, because nothing read the
 * label. These drive the gate through `RELEASE_GATE_CMD`, which replaces `gh`, so every
 * branch can be given its input without touching the network.
 *
 * The cases that matter most are the two where the gate CANNOT LOOK: a failed query and
 * a missing label. Both must refuse. A gate that reports clean when it could not see is
 * the defect this whole file exists to prevent, and it has been written by accident
 * twice in this repository already (#108, #109).
 */
const REPO = process.cwd()
const LAYOUT = readFileSync(join(REPO, '.manyportals-layout'), 'utf8').trim()

/** A stand-in for `gh`: answers `label list` and `issue list` from fixed text. */
function stubGh(opts: { labels?: string; issues?: string; failOn?: 'label' | 'issue' }): string {
  const d = mkdtempSync(join(tmpdir(), 'mp-gate-'))
  const p = join(d, 'gh')
  writeFileSync(
    p,
    `#!/usr/bin/env bash
case "$1 $2" in
  "label list")
    ${opts.failOn === 'label' ? 'echo "gh: HTTP 401" >&2; exit 1' : `printf '%b' ${JSON.stringify(opts.labels ?? '')}`}
    ;;
  "issue list")
    ${opts.failOn === 'issue' ? 'echo "gh: HTTP 500" >&2; exit 1' : `printf '%b' ${JSON.stringify(opts.issues ?? '')}`}
    ;;
  *) echo "stub: unexpected $*" >&2; exit 99 ;;
esac
`,
  )
  chmodSync(p, 0o755)
  return p
}

function gate(stub: string, args: string[]): { rc: number; out: string } {
  try {
    const out = execFileSync('bash', ['scripts/release-gate.sh', ...args], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, RELEASE_GATE_CMD: stub, RELEASE_GATE_REPO: 'example/repo' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { rc: 0, out }
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string }
    return {
      rc: typeof x.status === 'number' ? x.status : -1,
      out: (x.stdout ?? '') + (x.stderr ?? ''),
    }
  }
}

const WAVES = 'wave:0.1.9\nwave:0.2.0\nsev:med\n'

describe.skipIf(LAYOUT !== 'dev')('release-gate.sh', () => {
  it('passes when the wave has no open issues', () => {
    const r = gate(stubGh({ labels: WAVES, issues: '' }), ['0.1.9'])
    expect(r.rc).toBe(0)
    expect(r.out).toContain('clean')
  })

  it('refuses and names the issues when the wave is not clear', () => {
    const r = gate(stubGh({ labels: WAVES, issues: '  #42 something unfinished\n' }), ['0.1.9'])
    expect(r.rc).toBe(1)
    expect(r.out).toContain('#42')
    expect(r.out).toContain('1 open issue')
  })

  it('refuses a mistyped version rather than reporting an empty wave clean', () => {
    // THE SUBTLE ONE. `0.19` for `0.1.9` queries a label nobody uses, which returns
    // nothing, which without this check reads as "nothing open" while the real wave is
    // untouched. The gate's own silent failure had to be closed before the gate was
    // worth having.
    const r = gate(stubGh({ labels: WAVES, issues: '' }), ['0.19'])
    expect(r.rc).toBe(1)
    expect(r.out).toContain('no label')
  })

  it('refuses when the label query fails, rather than calling it clean', () => {
    const r = gate(stubGh({ failOn: 'label' }), ['0.1.9'])
    expect(r.rc).toBe(1)
    expect(r.out).toContain('Refusing')
  })

  it('refuses when the issue query fails, rather than calling it clean', () => {
    const r = gate(stubGh({ labels: WAVES, failOn: 'issue' }), ['0.1.9'])
    expect(r.rc).toBe(1)
    expect(r.out).toContain('Refusing')
  })

  it('allows an override that states a reason, and prints it', () => {
    const r = gate(stubGh({ labels: WAVES, issues: '  #42 deferred on purpose\n' }), [
      '0.1.9',
      '--anyway',
      'moved to 0.1.10, release is time-boxed',
    ])
    expect(r.rc).toBe(0)
    expect(r.out).toContain('OVERRIDDEN')
    expect(r.out).toContain('time-boxed')
  })

  it('refuses an override with no reason', () => {
    // Without this the escape hatch can be used silently, which retires the gate.
    const r = gate(stubGh({ labels: WAVES, issues: '  #42 x\n' }), ['0.1.9', '--anyway'])
    expect(r.rc).toBe(2)
    expect(r.out).toContain('needs a reason')
  })

  it('says so when an override was not needed', () => {
    // Silence here would train the operator to pass --anyway by habit, which retires
    // the gate by attrition rather than by decision.
    const r = gate(stubGh({ labels: WAVES, issues: '' }), ['0.1.9', '--anyway', 'belt and braces'])
    expect(r.rc).toBe(0)
    expect(r.out).toContain('was not needed')
  })

  it('refuses an unknown argument instead of ignoring it', () => {
    const r = gate(stubGh({ labels: WAVES, issues: '' }), ['0.1.9', '--force'])
    expect(r.rc).toBe(2)
    expect(r.out).toContain('unknown argument')
  })
})
