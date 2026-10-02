import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Four shipped checks need to know whether they are in the private development tree or
 * in the assembled public one. They each answered it with `[ -d public ]`, so creating
 * an empty directory of that name in the public repo switched them to the development
 * file set: the credential scan stopped reading docs/*.md and printed "clean", and the
 * link check walked an empty directory and reported every link resolved. `public/` is
 * an ordinary directory name, so no adversary was required (#107).
 *
 * The tree now DECLARES what it is, and both readers refuse to guess. These cases pin
 * the refusals, because a guard that answers "public" when it cannot tell is the same
 * defect wearing a different implementation.
 */
const REPO = process.cwd()

/** A directory carrying `.manyportals-layout` with the given contents, or none. */
function tree(marker: string | null): string {
  const d = mkdtempSync(join(tmpdir(), 'layout-'))
  if (marker !== null) writeFileSync(join(d, '.manyportals-layout'), marker)
  return d
}

/**
 * Both readers are run as a PROCESS, the way every caller runs them: prose-check and
 * credscan source the shell one, docs-links and the guard register import the node one
 * from a script rather than from typed source. A refusal therefore shows up as a
 * non-zero exit, not an exception, and that is what each caller actually sees.
 */
function run(cmd: string, args: string[], dir: string): { rc: number; out: string } {
  try {
    const out = execFileSync(cmd, [...args, dir], {
      encoding: 'utf8',
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

const shellLayout = (dir: string): { rc: number; out: string } =>
  run('bash', ['-c', `source "${REPO}/scripts/layout.sh"; mp_layout "$1"`, '_'], dir)

const nodeLayout = (dir: string): { rc: number; out: string } =>
  run(
    'node',
    [
      '--input-type=module',
      '-e',
      `import { mpLayout } from ${JSON.stringify(pathToFileURL(join(REPO, 'scripts', 'layout.mjs')).href)}
       process.stdout.write(mpLayout(process.argv[1]))`,
    ],
    dir,
  )

describe.each([
  ['node', nodeLayout],
  ['bash', shellLayout],
] as const)('%s reader', (_name, reader) => {
  /** The declared layout, or a throw carrying whatever the reader said. */
  const read = (dir: string): string => {
    const r = reader(dir)
    if (r.rc !== 0) throw new Error(r.out)
    return r.out
  }
  it.each(['dev', 'public'])('reads a tree declared as %s', (want) => {
    const d = tree(`${want}\n`)
    expect(read(d)).toBe(want)
    rmSync(d, { recursive: true, force: true })
  })

  it('tolerates a declaration written without a trailing newline', () => {
    const d = tree('public')
    expect(read(d)).toBe('public')
    rmSync(d, { recursive: true, force: true })
  })

  it('refuses when there is no declaration, rather than picking one', () => {
    const d = tree(null)
    expect(() => read(d)).toThrow(/manyportals-layout/)
    rmSync(d, { recursive: true, force: true })
  })

  it('refuses a declaration it does not recognise', () => {
    const d = tree('production\n')
    expect(() => read(d)).toThrow(/production/)
    rmSync(d, { recursive: true, force: true })
  })

  it('refuses an empty declaration, which a truncated write would leave behind', () => {
    const d = tree('')
    expect(() => read(d)).toThrow()
    rmSync(d, { recursive: true, force: true })
  })

  it('is not swayed by a directory named public', () => {
    const d = tree('public\n')
    mkdirSync(join(d, 'public'), { recursive: true })
    expect(read(d)).toBe('public')
    rmSync(d, { recursive: true, force: true })
  })

  it('is not swayed by the absence of one', () => {
    const d = tree('dev\n')
    expect(read(d)).toBe('dev')
    rmSync(d, { recursive: true, force: true })
  })
})

describe('the two readers agree', () => {
  // This file SHIPS, so it runs in both trees and must not assume either. Asserting
  // `dev` here passed in the development repo and failed inside the assembled public
  // one, which is a smaller copy of the very fault #107 is about: a check that only
  // knows one layout. What must hold everywhere is that both readers answer, and
  // answer the same thing.
  it('gives whichever tree they are run in one answer, not two', () => {
    const fromNode = nodeLayout(REPO)
    expect(fromNode.rc).toBe(0)
    expect(['dev', 'public']).toContain(fromNode.out)
    expect(shellLayout(REPO)).toEqual(fromNode)
  })
})

/**
 * The normalisation is SPECIFIED, and both readers implement the same specification
 * (#127). Before this table, `layout.sh` used `tr -d '[:space:]'` and `layout.mjs` used
 * `.trim()`, and they disagreed in BOTH directions:
 *
 *   - the shell reader deleted whitespace everywhere, so `d e v` was accepted as `dev`
 *     and `pub lic` as `public`. credscan then applied the wrong pathspec and reported
 *     a clean tree having scanned the wrong file set.
 *   - `.trim()` follows Unicode whitespace, so a UTF-8 BOM and a non-breaking space
 *     were accepted by the node reader and refused by the shell one. A BOM is what a
 *     Windows editor writes, and this repository has Windows CI, so that was the
 *     reachable half.
 *
 * Every row is asserted against BOTH readers. A row that only one reader is asked about
 * is how the two came apart in the first place.
 */
const ACCEPTED: ReadonlyArray<readonly [string, string, string]> = [
  ['a trailing newline', 'dev\n', 'dev'],
  ['spaces at both ends', ' dev ', 'dev'],
  ['a CRLF line ending', 'dev\r\n', 'dev'],
  ['two trailing newlines', 'dev\n\n', 'dev'],
  ['tabs at both ends', '\tdev\t', 'dev'],
  ['no line ending at all', 'dev', 'dev'],
  ['a trailing vertical tab', 'dev\v', 'dev'],
  ['a trailing form feed', 'dev\f', 'dev'],
  ['a UTF-8 BOM, as a Windows editor writes it', '﻿dev', 'dev'],
  ['a UTF-8 BOM on the public marker', '﻿public\n', 'public'],
]

const REFUSED: ReadonlyArray<readonly [string, string]> = [
  ['whitespace between every letter', 'd e v'],
  ['a single internal space', 'de v'],
  ['an internal newline', 'd\nev'],
  ['an internal space in public', 'pub lic'],
  ['a trailing non-breaking space', 'dev '],
  ['a leading non-breaking space', ' dev'],
  ['both words at once', 'dev public'],
  ['the right word in the wrong case', 'DEV'],
  ['nothing at all', ''],
  ['whitespace and nothing else', '   '],
]

describe('the two readers normalise identically', () => {
  it.each(ACCEPTED)('accepts %s, in both readers', (_label, marker, expected) => {
    const d = tree(marker)
    const fromNode = nodeLayout(d)
    const fromShell = shellLayout(d)
    expect(fromNode.rc, `node said: ${fromNode.out}`).toBe(0)
    expect(fromNode.out).toBe(expected)
    // Compared as a whole, so a reader that answers differently fails here rather than
    // in whichever gate happens to read the marker next.
    expect(fromShell).toEqual(fromNode)
    rmSync(d, { recursive: true, force: true })
  })

  // Refusals compare the STATUS, not the text: each reader words its own message and
  // callers only ever see the exit status.
  it.each(REFUSED)('refuses %s, in both readers', (_label, marker) => {
    const d = tree(marker)
    const fromNode = nodeLayout(d)
    const fromShell = shellLayout(d)
    expect(fromNode.rc, `node accepted it: ${fromNode.out}`).not.toBe(0)
    expect(fromShell.rc, `bash accepted it: ${fromShell.out}`).not.toBe(0)
    rmSync(d, { recursive: true, force: true })
  })
})
