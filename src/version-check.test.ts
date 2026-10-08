import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * version-check.mjs SHIPS, and it guards the one thing a release edits by hand in three
 * places: package.json, manifest.json and a prose line in the published documents.
 *
 * The prose half is why this exists. A status sentence that must track a mechanical
 * value cannot be diffed against anything, so it drifts silently and a reader takes
 * "as of 0.1.4" as current (#129).
 */
const REPO = process.cwd()

/**
 * version-check.mjs imports layout.mjs, so the fixture needs BOTH. Fifth time a script
 * gained a sibling dependency and every fixture copying it had to follow; the class is
 * #137, and the failure without this is ERR_MODULE_NOT_FOUND from a temporary directory,
 * which reads as the script being broken rather than the fixture being short a file.
 */
const MARKER = '<!-- version-check: release-tag -->'

/** The designated release-tag instruction, correct for `pkg`. */
const signing = (pkg: string) =>
  `# Signing\n\n${MARKER}\n\n\`\`\`sh\ngit verify-tag v${pkg}\n\`\`\`\n`

function fixture(opts: {
  pkg: string
  manifest: string
  docs?: Record<string, string>
  layout?: string
  /**
   * The rule refuses when NO document designates the instruction, so every fixture needs
   * one or it fails for a reason the test is not about. `tagDoc: false` is for the tests
   * that supply their own marker, or that are about an empty document set.
   */
  tagDoc?: boolean
}): string {
  const d = mkdtempSync(join(tmpdir(), 'vercheck-'))
  mkdirSync(join(d, 'scripts'), { recursive: true })
  for (const f of ['version-check.mjs', 'layout.mjs']) {
    copyFileSync(join(REPO, 'scripts', f), join(d, 'scripts', f))
  }
  writeFileSync(join(d, '.manyportals-layout'), `${opts.layout ?? 'public'}\n`)
  writeFileSync(join(d, 'package.json'), JSON.stringify({ version: opts.pkg }, null, 2))
  writeFileSync(join(d, 'manifest.json'), JSON.stringify({ version: opts.manifest }, null, 2))
  const docs = { ...(opts.docs ?? { 'README.md': '# Doc\n\nPlain text.\n' }) }
  if (opts.tagDoc !== false) docs['SIGNING.md'] = signing(opts.pkg)
  for (const [rel, body] of Object.entries(docs)) {
    const abs = join(d, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  return d
}

function run(dir: string, args: string[] = []): { rc: number; out: string } {
  try {
    const out = execFileSync('node', ['scripts/version-check.mjs', ...args], {
      cwd: dir,
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

describe('version-check', () => {
  it('passes when every surface agrees', () => {
    const r = run(
      fixture({
        pkg: '0.2.0',
        manifest: '0.2.0',
        docs: { 'README.md': 'Documented as of 0.2.0.\n' },
      }),
    )
    expect(r.rc, r.out).toBe(0)
    expect(r.out).toContain('agrees across')
  })

  it('refuses when the manifest and the package disagree', () => {
    const r = run(fixture({ pkg: '0.2.0', manifest: '0.1.4' }))
    expect(r.rc).toBe(1)
    // Both values named, so the reader does not have to go and look them up.
    expect(r.out).toContain('"0.1.4"')
    expect(r.out).toContain('"0.2.0"')
  })

  it('refuses a stale as-of line in a published document', () => {
    const r = run(
      fixture({
        pkg: '0.2.0',
        manifest: '0.2.0',
        docs: { 'SECURITY.md': 'These are documented rather than fixed, as of 0.1.4.\n' },
      }),
    )
    expect(r.rc).toBe(1)
    expect(r.out).toContain('as of 0.1.4')
  })

  // The row an over-broad rule breaks. A version named as a HISTORICAL threshold is not a
  // status and must not be rewritten every release, which is how a check trains people to
  // ignore it. Only the explicit `as of <x.y.z>` marker is a claim about now.
  it('leaves a historical version reference alone', () => {
    const r = run(
      fixture({
        pkg: '0.2.0',
        manifest: '0.2.0',
        docs: {
          'NOTES.md': 'Required for any build at or after 0.1.2. Since 0.1.4 the two agree.\n',
        },
      }),
    )
    expect(r.rc, r.out).toBe(0)
  })

  // THE RELEASE-TAG INSTRUCTION.
  //
  // This rule has been wrong three times, each time because it RECOGNISED fragments instead
  // of VALIDATING the whole instruction, and each time it carried a green matrix and a
  // registered mutation while being wrong (#279, #281, #283, #284, #285, #286).
  //
  // It now validates ONE template and refuses everything else, so the matrix below is the
  // specification. Both columns are written out: the accept column has twice caught a false
  // refusal that the refuse column could not (L22).
  const marked = (cmd: string, fence = '```') =>
    `# Signing\n\n${MARKER}\n\n${fence}sh\n${cmd}\n${fence}\n`
  const doc = (body: string, extra: Record<string, string> = {}) =>
    fixture({
      pkg: '0.1.10',
      manifest: '0.1.10',
      tagDoc: false,
      docs: { 'SECURITY.md': body, ...extra },
    })

  const accept: [string, string][] = [
    ['a backtick fence naming this release', marked('git verify-tag v0.1.10')],
    ['a tilde fence', marked('git verify-tag v0.1.10', '~~~')],
    [
      'a context command above the instruction',
      `# S\n\n${MARKER}\n\n\`\`\`sh\ngit config gpg.ssh.allowedSignersFile x\ngit verify-tag v0.1.10\n\`\`\`\n`,
    ],
    [
      'a full-line comment beside the instruction',
      `# S\n\n${MARKER}\n\n\`\`\`sh\n# run this from a clone\ngit verify-tag v0.1.10\n\`\`\`\n`,
    ],
    [
      'a closing fence longer than its opener',
      `# S\n\n${MARKER}\n\n\`\`\`sh\ngit verify-tag v0.1.10\n\`\`\`\`\`\n`,
    ],
    // A document may one day DOCUMENT this convention. A marker inside a fence is an
    // example, not a designation, so the check that enforces the convention does not fire on
    // the text explaining it.
    [
      'a marker shown as an example inside a fence',
      marked('git verify-tag v0.1.10') + `\nExample:\n\n\`\`\`md\n${MARKER}\n\`\`\`\n`,
    ],
    // CRLF: `.` does not match \r and `$` without /m will not match before it, so every fence
    // line failed to parse and a CORRECT instruction was refused. Accept column, again.
    ['CRLF line endings', marked('git verify-tag v0.1.10').replace(/\n/g, '\r\n')],
    // INDENTATION, the dimension 37 rows never varied — which is why three stale-shipping
    // cases survived them (#288). CommonMark permits up to three spaces on either fence.
    [
      'a closing fence indented three spaces',
      `# S\n\n${MARKER}\n\n\`\`\`sh\ngit verify-tag v0.1.10\n   \`\`\`\n`,
    ],
    [
      'an opening fence indented three spaces',
      `# S\n\n${MARKER}\n\n   \`\`\`sh\n   git verify-tag v0.1.10\n   \`\`\`\n`,
    ],
    [
      'a marker and fence indented two spaces, as a list continuation',
      `# S\n\n  ${MARKER}\n\n  \`\`\`sh\n  git verify-tag v0.1.10\n  \`\`\`\n`,
    ],
    // Category 3: a context command is permitted, provided it names no other release.
    [
      'a context command carrying no version token',
      `# S\n\n${MARKER}\n\n\`\`\`sh\ngit config gpg.ssh.allowedSignersFile x\ngit verify-tag v0.1.10\n\`\`\`\n`,
    ],
    [
      'a context command naming THIS release',
      `# S\n\n${MARKER}\n\n\`\`\`sh\ngit verify-tag v0.1.10\necho checking v0.1.10\n\`\`\`\n`,
    ],
  ]
  for (const [what, body] of accept) {
    it(`accepts ${what}`, () => {
      expect(run(doc(body)).rc, run(doc(body)).out).toBe(0)
    })
  }

  it('leaves a changelog quoting a past release untouched', () => {
    const r = run(
      doc(marked('git verify-tag v0.1.10'), {
        'CHANGELOG.md': '# 0.1.9\n\nVerified with `git verify-tag v0.1.9`.\n',
      }),
    )
    expect(r.rc, r.out).toBe(0)
  })

  it('leaves a generic verify-tag mention in another document alone', () => {
    const r = run(
      doc(marked('git verify-tag v0.1.10'), {
        'DOC.md': 'Run `git verify-tag` on the tag you downloaded.\n',
      }),
    )
    expect(r.rc, r.out).toBe(0)
  })

  // Every row a reviewer broke, plus the ones carried forward. Each names WHICH defect it
  // pins, because a row whose purpose is forgotten is a row someone deletes to go green.
  const refuse: [string, string][] = [
    ['the previous release tag', marked('git verify-tag v0.1.9')],
    // #279: `\b` ended the old match at the hyphen, so this read as 0.1.10.
    ['a prerelease of this version', marked('git verify-tag v0.1.10-rc.1')],
    ['a quoted tag, which is not the one supported spelling', marked('git verify-tag "v0.1.9"')],
    [
      'an option, which is not the one supported spelling',
      marked('git verify-tag --verbose v0.1.10'),
    ],
    // #284: two operands, and the old rule stopped after the first.
    ['two tag operands', marked('git verify-tag v0.1.10 v0.1.9')],
    // #284, the sharp one: v0.1.10 is --format's VALUE, and the only tag is v0.1.9.
    ['an option whose value looks like the tag', marked('git verify-tag --format v0.1.10 v0.1.9')],
    // #284: an unsupported form must not hide beside a recognised good one.
    [
      'an unsupported spelling beside a correct command',
      `# S\n\n${MARKER}\n\n\`\`\`sh\ngit verify-tag v0.1.10\ngit 'verify-tag' v0.1.9\n\`\`\`\n`,
    ],
    [
      'a tagless command beside a correct one',
      `# S\n\n${MARKER}\n\n\`\`\`sh\ngit verify-tag v0.1.10\ngit verify-tag\n\`\`\`\n`,
    ],
    // #285: a comment cannot supply command presence.
    [
      'a commented-out command as the only instruction',
      `# S\n\n${MARKER}\n\n\`\`\`sh\n# git verify-tag v0.1.10\ngit status\n\`\`\`\n`,
    ],
    ['verify-tag inside another command', marked('echo git verify-tag v0.1.10')],
    // #286: CommonMark allows only whitespace after a closing fence, so the stale command
    // below this line is still INSIDE the designated block.
    [
      'text after a closing fence hiding a stale command',
      `# S\n\n${MARKER}\n\n~~~sh\ngit verify-tag v0.1.10\n~~~ not a closing fence\ngit verify-tag v0.1.9\n~~~\n`,
    ],
    // #283: the duplicated-section case. The old rule counted FILES, so this passed.
    [
      'a second designation in the same document',
      `# S\n\n${MARKER}\n\n~~~sh\ngit verify-tag v0.1.10\n~~~\n\n${MARKER}\n\n~~~sh\ngit verify-tag v0.1.9\n~~~\n`,
    ],
    [
      'a marker that is not alone on its line',
      `# S\n\nFrom a clone: ${MARKER}\n\n\`\`\`sh\ngit verify-tag v0.1.10\n\`\`\`\n`,
    ],
    [
      'prose between the marker and the fence',
      `# S\n\n${MARKER}\n\nRun this:\n\n\`\`\`sh\ngit verify-tag v0.1.10\n\`\`\`\n`,
    ],
    [
      'a marker whose block sits under the next heading',
      `# A\n\n${MARKER}\n\n## B\n\n\`\`\`sh\ngit verify-tag v0.1.9\n\`\`\`\n`,
    ],
    ['a fence that is never closed', `# S\n\n${MARKER}\n\n\`\`\`sh\ngit verify-tag v0.1.9\n`],
    ['a block that runs something else', marked('git status')],
    ['no designation anywhere', '# S\n\n```sh\ngit verify-tag v0.1.10\n```\n'],
    // #288: CommonMark gives a fence TWO conditions and only the second was enforced. A line
    // indented four spaces is INDENTED CODE, not a fence, so these end the block early and the
    // stale command below is still inside it. marked@18.1.0 returns one code token for each.
    [
      'a closing fence indented four spaces, hiding a stale command',
      `# S\n\n${MARKER}\n\n\`\`\`sh\ngit verify-tag v0.1.10\n    \`\`\`\ngit verify-tag v0.1.9\n\`\`\`\n`,
    ],
    [
      'a tab-indented closing fence, hiding a stale command',
      `# S\n\n${MARKER}\n\n~~~sh\ngit verify-tag v0.1.10\n\t~~~\ngit verify-tag v0.1.9\n~~~\n`,
    ],
    [
      'an opening fence indented four spaces',
      `# S\n\n${MARKER}\n\n    \`\`\`sh\n    git verify-tag v0.1.10\n    \`\`\`\n    git verify-tag v0.1.9\n`,
    ],
    // #289: git's own synonym for the command, which contains no `verify-tag` substring, so a
    // deny-list keyed on that string could not see a stale, visible, runnable command.
    [
      'git tag -v naming another release',
      `# S\n\n${MARKER}\n\n\`\`\`sh\ngit verify-tag v0.1.10\ngit tag -v v0.1.9\n\`\`\`\n`,
    ],
    [
      'git tag --verify naming another release',
      `# S\n\n${MARKER}\n\n\`\`\`sh\ngit verify-tag v0.1.10\ngit tag --verify v0.1.9\n\`\`\`\n`,
    ],
    [
      'another release assigned to a variable',
      `# S\n\n${MARKER}\n\n\`\`\`sh\nTAG=v0.1.9\ngit verify-tag v0.1.10\n\`\`\`\n`,
    ],
    [
      'another release on a line continuation',
      `# S\n\n${MARKER}\n\n\`\`\`sh\ngit verify-tag v0.1.10\ngit tag \\\n  -v v0.1.9\n\`\`\`\n`,
    ],
  ]
  for (const [what, body] of refuse) {
    it(`refuses ${what}`, () => {
      expect(run(doc(body)).rc).toBe(1)
    })
  }

  it('refuses a second designation in another document', () => {
    const r = run(
      doc(marked('git verify-tag v0.1.10'), { 'OTHER.md': marked('git verify-tag v0.1.10') }),
    )
    expect(r.rc).toBe(1)
    expect(r.out).toContain('2 designations')
  })

  // #291: a marker appears as literal TEXT three ways, and only the fenced one was exempt.
  // The indented spelling is EXACTLY how the refusal message prints the marker, so pasting the
  // checker's own output into a document broke the build. The inline span is the sentence this
  // project will certainly write.
  it('ignores a marker quoted in an indented code block', () => {
    const r = run(
      doc(marked('git verify-tag v0.1.10'), {
        'CONTRIBUTING.md': `# C\n\nThe shape:\n\n    ${MARKER}\n\n    \`\`\`sh\n    git verify-tag v<version>\n    \`\`\`\n`,
      }),
    )
    expect(r.rc, r.out).toBe(0)
  })

  it('ignores a marker named in an inline code span', () => {
    const r = run(
      doc(marked('git verify-tag v0.1.10'), {
        'CONTRIBUTING.md': `# C\n\nPut \`${MARKER}\` alone on its line.\n`,
      }),
    )
    expect(r.rc, r.out).toBe(0)
  })

  // #290: the occurrence count rides the same fence scanner, so an indented fence upstream
  // desynchronised it and a second marked instruction went uncounted — #283 by another route.
  it('counts a second designation past an indented code block', () => {
    const r = run(
      doc(marked('git verify-tag v0.1.10'), {
        'CHANGELOG.md': `# 0.1.9\n\nShape:\n\n    \`\`\`sh\n\nOld section:\n\n${MARKER}\n\n\`\`\`sh\ngit verify-tag v0.1.9\n\`\`\`\n`,
      }),
    )
    expect(r.rc).toBe(1)
  })

  // #292: the as-of rule knew ONE phrasing, and the published set holds exactly one such
  // sentence — so a copy-edit fronting that clause would have silenced it permanently.
  const asOf: [string, string][] = [
    ['fronted at the start of a sentence', 'As of 0.1.4, these are documented.'],
    ['with the word version', 'Documented as of version 0.1.4.'],
    ['with a v prefix', 'Documented as of v0.1.4.'],
    ['in upper case', '## AS OF 0.1.4'],
    ['across a non-breaking space', 'Documented as of\u00a00.1.4.'],
  ]
  for (const [what, sentence] of asOf) {
    it(`refuses a stale as-of ${what}`, () => {
      const r = run(doc(marked('git verify-tag v0.1.10') + `\n${sentence}\n`))
      expect(r.rc).toBe(1)
      expect(r.out).toContain('0.1.4')
    })
  }

  it('accepts an as-of naming the current version', () => {
    const r = run(doc(marked('git verify-tag v0.1.10') + '\nDocumented as of 0.1.10.\n'))
    expect(r.rc, r.out).toBe(0)
  })

  // #293: a malformed version file is "I could not look" and must arrive as a reason, not as a
  // stack escaping to the operator. The document-root case already asserted this; these did not.
  it('refuses an unparseable manifest with a reason and no stack', () => {
    const d = fixture({
      pkg: '0.1.10',
      manifest: '0.1.10',
      tagDoc: false,
      docs: { 'SECURITY.md': marked('git verify-tag v0.1.10') },
    })
    writeFileSync(join(d, 'manifest.json'), '{ not json')
    const r = run(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('not valid JSON')
    expect(r.out).not.toContain('at Object.')
  })

  // The refusal has to be actionable: three rounds of this rule were fixed by reading the
  // required shape, so the message carries it.
  it('names the required shape when it refuses', () => {
    const r = run(doc(marked('git verify-tag v0.1.9')))
    expect(r.out).toContain('git verify-tag v0.1.9')
  })

  // Two distinct faults, kept apart.  // Two distinct faults, kept apart. Collapsing "I could not look" into "there is nothing
  // there" is the defect #111 was about, and the first version of this script did exactly
  // that: a missing root escaped as a stack trace, which exits non-zero by accident
  // rather than by design and hands the operator a crash instead of a reason.
  // The tag is the third surface that can drift, and the only one that cannot be checked
  // from inside the tree: at verify time there is no tag. The release step asks with
  // --tag rather than trusting an eye (#35).
  it('accepts a tag that matches the package version', () => {
    const r = run(fixture({ pkg: '0.2.0', manifest: '0.2.0' }), ['--tag', 'v0.2.0'])
    expect(r.rc, r.out).toBe(0)
  })

  it('refuses a tag that labels a different build', () => {
    const r = run(fixture({ pkg: '0.1.4', manifest: '0.1.4' }), ['--tag', 'v0.2.0'])
    expect(r.rc).toBe(1)
    expect(r.out).toContain('does not match package.json 0.1.4')
  })

  it('refuses when the document root cannot be read', () => {
    const r = run(fixture({ pkg: '0.2.0', manifest: '0.2.0', docs: {}, layout: 'dev' }))
    expect(r.rc).toBe(1)
    expect(r.out).toContain('could not read public/')
    expect(r.out).not.toContain('at Object.')
  })

  it('refuses when the root is readable but holds no documents', () => {
    const d = fixture({ pkg: '0.2.0', manifest: '0.2.0', docs: {}, layout: 'dev' })
    mkdirSync(join(d, 'public'), { recursive: true })
    const r = run(d)
    expect(r.rc).toBe(1)
    expect(r.out).toContain('nothing was checked')
  })
})
