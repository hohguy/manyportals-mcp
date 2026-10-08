import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The claims register's own check (#94, #200).
 *
 * Every clause here is driven with the input that makes it FIRE. A guard is not finished
 * when it exists; it is finished when you can name the input that makes it fail and have
 * written that input down (#124). This file is that writing-down, and the register is the
 * one gate in this repository whose subject is PROSE, where a clause that quietly matched
 * nothing would be invisible for exactly as long as the sentences it was meant to police.
 *
 * `checkStructure` and `checkTestsPassed` both take their collaborator as an argument —
 * a document reader and a test runner — so the cases below need neither a fixture tree nor
 * a real vitest run. A fixture tree has no node_modules, which is how an isolated worktree
 * broke the artifact build earlier in this same cohort.
 */
const REPO = process.cwd()
const MJS = pathToFileURL(join(REPO, 'scripts', 'claims-register.mjs')).href

const DOC = `# D

## What it protects

- **Alpha.** Beta. Gamma.

## Elsewhere
`

interface Seg {
  kind: string
  text: string
  test?: string
  expect?: string
  why?: string
  what?: string
  date?: string
  recheck?: string
  client?: string
  clientVersion?: string
  recheckBy?: string
}
interface Bullet {
  doc: string
  section: string
  heading: string
  segments: Seg[]
}
interface Register {
  exemptBaseline?: number
  observedBaseline?: number
  pendingBaseline?: number
  pending?: { heading?: string; ticket?: string; why?: string }[]
  bullets: Bullet[]
}

/**
 * Typed accessors rather than `!` or a cast. They throw on a malformed fixture, which
 * makes a mistake in a case below fail as itself instead of as the clause it was meant to
 * exercise — the same reason every case here asserts non-vacuity before asserting content.
 */
function bullet(r: Register): Bullet {
  const b = r.bullets[0]
  if (b === undefined) throw new Error('fixture has no bullet')
  return b
}
function seg(r: Register, i: number): Seg {
  const s = bullet(r).segments[i]
  if (s === undefined) throw new Error(`fixture has no segment ${i}`)
  return s
}

/** The register that SHOULD pass, which every failing case below mutates one field of. */
function clean(): Register {
  return {
    exemptBaseline: 0,
    observedBaseline: 0,
    pendingBaseline: 0,
    pending: [],
    bullets: [
      {
        doc: 'd.md',
        section: 'What it protects',
        heading: 'Alpha.',
        segments: [
          { kind: 'claim', text: '- **Alpha.**', test: 'src/plans/plans.test.ts', expect: 'a' },
          { kind: 'claim', text: ' Beta.', test: 'src/plans/plans.test.ts', expect: 'b' },
          { kind: 'claim', text: ' Gamma.', test: 'src/plans/plans.test.ts', expect: 'c' },
        ],
      },
    ],
  }
}

function structure(
  register: Register | Record<string, unknown>,
  docs: Record<string, string> = { 'd.md': DOC },
  // The clock is injectable for ONE clause: an observation dated in the future. Without it
  // that clause has no reachable input, and a clause whose input cannot be supplied cannot
  // be proven able to fail (#124).
  now = '2026-10-06T12:00:00Z',
): string[] {
  const out = execFileSync(
    'node',
    [
      '--input-type=module',
      '-e',
      `import { checkStructure } from ${JSON.stringify(MJS)}
       const { register, docs, now } = JSON.parse(process.argv[1])
       process.stdout.write(
         JSON.stringify(checkStructure(register, (p) => docs[p], new Date(now))),
       )`,
      JSON.stringify({ register, docs, now }),
    ],
    { cwd: REPO, encoding: 'utf8' },
  )
  return JSON.parse(out) as string[]
}

function tests(
  register: Register | Record<string, unknown>,
  assertions: unknown,
  throwIt = false,
): string[] {
  const out = execFileSync(
    'node',
    [
      '--input-type=module',
      '-e',
      `import { checkTestsPassed } from ${JSON.stringify(MJS)}
       const { register, assertions, throwIt } = JSON.parse(process.argv[1])
       const run = () => { if (throwIt) throw new Error('spawn refused'); return assertions }
       process.stdout.write(JSON.stringify(checkTestsPassed(register, run)))`,
      JSON.stringify({ register, assertions, throwIt }),
    ],
    { cwd: REPO, encoding: 'utf8' },
  )
  return JSON.parse(out) as string[]
}

describe('the claims register accepts a correct register', () => {
  it('reports no structural failure for the clean fixture', () => {
    expect(structure(clean())).toEqual([])
  })
})

describe('each structural clause fires on its own input', () => {
  it('refuses a register with no bullets, which would prove nothing', () => {
    expect(structure({ exemptBaseline: 0, pendingBaseline: 0, bullets: [] }).join(' ')).toMatch(
      /no bullets/,
    )
  })

  it('refuses a register with no numeric exemptBaseline, so the hatch cannot be unratcheted', () => {
    const r = clean()
    delete r.exemptBaseline
    expect(structure(r).join(' ')).toMatch(/exemptBaseline/)
  })

  it('refuses a register with no numeric pendingBaseline, so the debt cannot be uncounted', () => {
    const r = clean()
    delete r.pendingBaseline
    expect(structure(r).join(' ')).toMatch(/pendingBaseline/)
  })

  it('REFUSES A BULLET THAT IS NEITHER REGISTERED NOR PENDING', () => {
    // THE LOAD-BEARING CLAUSE. Reconstruction only governs bullets the register already
    // knows about, so without this one a whole new published claim could carry no test and
    // nothing would say so. It is the clause that forces a new sentence to be decided on.
    const doc = DOC.replace('## Elsewhere', '- **Delta.** Epsilon.\n\n## Elsewhere')
    expect(structure(clean(), { 'd.md': doc }).join(' ')).toMatch(/neither registered nor pending/)
  })

  it('refuses a bullet that is both registered and pending, which would silence it', () => {
    const r = clean()
    r.pending = [{ heading: 'Alpha.', ticket: '#1' }]
    r.pendingBaseline = 1
    expect(structure(r).join(' ')).toMatch(/both registered and pending/)
  })

  it('refuses pending growing past its baseline', () => {
    const doc = DOC.replace('## Elsewhere', '- **Delta.** Epsilon.\n\n## Elsewhere')
    const r = clean()
    r.pending = [{ heading: 'Delta.', ticket: '#1' }]
    r.pendingBaseline = 0
    expect(structure(r, { 'd.md': doc }).join(' ')).toMatch(/may only SHRINK/)
  })

  it('refuses a baseline left above the work, so the number follows the ratchet down', () => {
    const r = clean()
    r.pendingBaseline = 3
    expect(structure(r).join(' ')).toMatch(/lower pendingBaseline/)
  })

  it('refuses a pending entry with no ticket', () => {
    const doc = DOC.replace('## Elsewhere', '- **Delta.** Epsilon.\n\n## Elsewhere')
    const r = clean()
    r.pending = [{ heading: 'Delta.' }]
    r.pendingBaseline = 1
    expect(structure(r, { 'd.md': doc }).join(' ')).toMatch(/needs a heading and a ticket/)
  })

  it('REFUSES A HEADING THAT IS NOT ITSELF A CLAIM', () => {
    // The heading rule. Bold text is written to be read alone, so it carries its own test
    // or it gets reworded — the one disagreement between the three 2026-10-05 reviews was
    // about exactly this, on #202, and it was about the UNIT rather than about the code.
    const r = clean()
    bullet(r).segments[0] = { kind: 'exempt', text: '- **Alpha.**', why: 'calling it narrative' }
    r.exemptBaseline = 1
    expect(structure(r).join(' ')).toMatch(/first segment must be a claim/)
  })

  it('REFUSES SEGMENTS THAT DO NOT REJOIN TO THE DOCUMENT LINE', () => {
    // Reconstruction, and the reason there is no sentence splitter here: a splitter's
    // mistakes become the check's blind spots. Dropping a sentence from the register is
    // the case a splitter has to catch and this cannot miss.
    const r = clean()
    bullet(r).segments = [
      { kind: 'claim', text: '- **Alpha.**', test: 'src/plans/plans.test.ts', expect: 'a' },
      { kind: 'claim', text: ' Beta.', test: 'src/plans/plans.test.ts', expect: 'b' },
    ]
    expect(structure(r).join(' ')).toMatch(/do not rejoin/)
  })

  it('refuses a reworded sentence, which is how a claim drifts away from its test', () => {
    const r = clean()
    seg(r, 1).text = ' Beta and then some.'
    expect(structure(r).join(' ')).toMatch(/do not rejoin/)
  })

  it('refuses an exempt segment with no reason', () => {
    const r = clean()
    bullet(r).segments[2] = { kind: 'exempt', text: ' Gamma.' }
    r.exemptBaseline = 1
    expect(structure(r).join(' ')).toMatch(/exempt segment with no reason/)
  })

  it('refuses a claim with no test or no expect', () => {
    const r = clean()
    delete seg(r, 1).test
    expect(structure(r).join(' ')).toMatch(/no test or no expect/)
  })

  it('refuses a claim naming a test file that does not exist', () => {
    const r = clean()
    seg(r, 1).test = 'src/does-not-exist.test.ts'
    expect(structure(r).join(' ')).toMatch(/test file that does not exist/)
  })

  it('refuses an exempt count that disagrees with the baseline, and says not to just change it', () => {
    const r = clean()
    bullet(r).segments[2] = { kind: 'exempt', text: ' Gamma.', why: 'an instruction' }
    // exemptBaseline left at 0 while one exemption exists
    expect(structure(r).join(' ')).toMatch(/Do not just change the number/)
  })

  it('refuses an unreadable document rather than reporting it clean', () => {
    expect(structure(clean(), {}).join(' ')).toMatch(/cannot read d\.md/)
  })

  it('refuses a renamed section rather than finding no bullets in it', () => {
    // Could-not-look must never read as found-nothing (#108, #109). A section renamed in
    // the doc would otherwise silently retire every claim under it.
    const doc = DOC.replace('## What it protects', '## What it guards')
    expect(structure(clean(), { 'd.md': doc }).join(' ')).toMatch(/no section/)
  })

  it('refuses a section that holds no list at all', () => {
    const doc = '# D\n\n## What it protects\n\n## Elsewhere\n'
    expect(structure(clean(), { 'd.md': doc }).join(' ')).toMatch(/holds no list/)
  })
})

describe('the observed kind, for sentences about software this project does not control', () => {
  /** Segment 2 becomes an observation, which is the shape the real register needs. */
  function withObserved(over: Partial<Seg> = {}): Register {
    const r = clean()
    bullet(r).segments[2] = {
      kind: 'observed',
      text: ' Gamma.',
      what: 'another application shows a value on one of its screens',
      date: '2026-09-15',
      client: 'Some Client',
      clientVersion: '1.2.3',
      recheckBy: '2026-12-15',
      recheck: 'open that screen on the version you are running',
      why: 'No test here can watch another application, and exempt would be false: this asserts something specific.',
      ...over,
    }
    r.observedBaseline = 1
    return r
  }

  it('accepts an observation that says what, when, and how to re-check', () => {
    expect(structure(withObserved())).toEqual([])
  })

  it('refuses an observation that does not say what was observed', () => {
    expect(structure(withObserved({ what: undefined })).join(' ')).toMatch(/must say WHAT/)
  })

  it('refuses an observation with no way to re-check it', () => {
    // An observation of someone else's software ages. Without a re-check instruction the
    // reader is told a fact and given nothing to do when it stops being one.
    expect(structure(withObserved({ recheck: undefined })).join(' ')).toMatch(/how to re-check/)
  })

  it.each([
    ['', 'empty'],
    ['15 September 2026', 'long form'],
    ['2026-9-5', 'unpadded'],
  ])('refuses a non-ISO date (%s, %s)', (date) => {
    expect(structure(withObserved({ date })).join(' ')).toMatch(/needs a real calendar date/)
  })

  it.each([
    ['9999-99-99', 'month 99 and day 99'],
    ['2026-02-31', 'a day that does not exist in that month'],
  ])('REFUSES A SHAPE-VALID DATE THAT IS NOT A REAL DAY (%s, %s)', (date) => {
    // The shape test accepted both (#227). 2026-02-31 is the nastier one: `new Date` rolls
    // it over to 2 March rather than failing, so only a round trip catches it.
    expect(structure(withObserved({ date })).join(' ')).toMatch(/needs a real calendar date/)
  })

  it('REFUSES AN OBSERVATION DATED IN THE FUTURE', () => {
    // Nobody observed anything tomorrow. This refusal can only go from red to GREEN as time
    // passes, which is the safe direction: it never reddens an unchanged repository.
    expect(
      structure(withObserved({ date: '2027-01-01', recheckBy: '2027-06-01' })).join(' '),
    ).toMatch(/dated in the future/)
  })

  it('refuses an observation that does not name the client', () => {
    expect(structure(withObserved({ client: undefined })).join(' ')).toMatch(/name the CLIENT/)
  })

  it('refuses an observation that does not name the client version', () => {
    // "Claude Desktop masks the field" is a fact about one BUILD: the same field was plain
    // text on 2026-09-15 and masked on 2026-10-06, three weeks apart.
    expect(structure(withObserved({ clientVersion: undefined })).join(' ')).toMatch(
      /name the client VERSION/,
    )
  })

  it('accepts the literal "unknown" as a version, which an omitted field is not', () => {
    // An observation made before anyone thought to note the version is weaker evidence, and
    // saying so is the point of this kind. Omission is refused because an absent version
    // is indistinguishable from an unrecorded one; "unknown" is a declared weakness that
    // prints on every clean run.
    expect(structure(withObserved({ clientVersion: 'unknown' }))).toEqual([])
  })

  // Typed explicitly: a mixed `undefined | string` first column makes vitest infer a tuple
  // UNION, which a one-parameter callback cannot accept.
  const recheckCases: [string | undefined, string][] = [
    [undefined, 'absent'],
    ['soon', 'not a date'],
    ['2026-02-31', 'not a real day'],
  ]
  it.each(recheckCases)('refuses a recheckBy that is %s (%s)', (recheckBy) => {
    expect(structure(withObserved({ recheckBy })).join(' ')).toMatch(/recheckBy as a real calendar/)
  })

  it('refuses a recheckBy that is not AFTER the observation', () => {
    expect(structure(withObserved({ recheckBy: '2026-09-15' })).join(' ')).toMatch(
      /is not after the observation date/,
    )
  })

  it('ACCEPTS A recheckBy THAT HAS ALREADY PASSED, deliberately', () => {
    // PINNING AN OMISSION. `verify` must not fail with the passage of time and no change to
    // the repository: a gate that reddens on a Tuesday because nobody looked at a vendor's
    // UI gets disabled rather than satisfied, which is the argument that kept the
    // absolute-quantifier prose lint out of #94. recheckBy is DATA for #213's scheduled
    // report to read. If someone later "improves" this into a deadline, this test fails and
    // says why.
    expect(structure(withObserved({ date: '2026-01-01', recheckBy: '2026-02-01' }))).toEqual([])
  })

  it('REFUSES AN OBSERVATION HOLDING MORE THAN ONE SENTENCE', () => {
    // The compound this replaced held three sentences, and the middle one — "ManyPortals
    // declares the field sensitive" — was a claim about THIS project's own manifest, bound
    // to nothing, carrying a date and a re-check measured for someone else's interface.
    const r = withObserved({ text: ' Gamma. And one more thing.' })
    seg(r, 1).text = ' Beta.'
    bullet(r).segments = [seg(r, 0), seg(r, 1), seg(r, 2)]
    expect(
      structure(r, { 'd.md': DOC.replace('Gamma.', 'Gamma. And one more thing.') }).join(' '),
    ).toMatch(/holds 2 sentences/)
  })

  it('refuses an observation count that disagrees with its baseline', () => {
    const r = withObserved()
    r.observedBaseline = 0
    expect(structure(r).join(' ')).toMatch(/Do not just change the number/)
  })

  it('refuses a register with no numeric observedBaseline', () => {
    const r = clean()
    delete r.observedBaseline
    expect(structure(r).join(' ')).toMatch(/observedBaseline/)
  })

  it('REFUSES AN OBSERVATION AS A BULLET HEADING', () => {
    // The heading rule covers this kind too. A bold heading that rests on another
    // vendor's software is a heading this project cannot stand behind, and the answer is
    // to reword the heading, not to annotate it with a date.
    const r = clean()
    bullet(r).segments[0] = {
      kind: 'observed',
      text: '- **Alpha.**',
      what: 'x',
      date: '2026-09-15',
      client: 'Some Client',
      clientVersion: '1.2.3',
      recheckBy: '2026-12-15',
      recheck: 'y',
      why: 'z',
    }
    r.observedBaseline = 1
    expect(structure(r).join(' ')).toMatch(/first segment must be a claim/)
  })

  it('refuses an unknown kind, naming all three', () => {
    const r = clean()
    seg(r, 1).kind = 'probably-fine'
    expect(structure(r).join(' ')).toMatch(/use claim, exempt or observed/)
  })
})

describe('each test-binding clause fires on its own input', () => {
  // The shape `scripts/claims-reporter.mjs` writes: the exact full name, the state, and
  // whether the test was declared an EXPECTED FAILURE (#223).
  // "<describe> > <it>", because the binding matches the `it` TITLE exactly (#225).
  // A bare 'x a' would no longer match the claim whose expect is 'a', which is the point.
  const PASSED = [
    { fullName: 'the fixture > a', state: 'passed', fails: false },
    { fullName: 'the fixture > b', state: 'passed', fails: false },
    { fullName: 'the fixture > c', state: 'passed', fails: false },
  ]

  it('accepts claims whose named tests all passed', () => {
    expect(tests(clean(), PASSED)).toEqual([])
  })

  it('REFUSES A CLAIM WHOSE TEST NAME MATCHES NOTHING', () => {
    // A renamed or deleted test must not read as a satisfied claim. Zero matches is
    // "could not look", which is the defect this whole codebase refuses.
    expect(tests(clean(), [PASSED[0], PASSED[1]]).join(' ')).toMatch(/no test is named exactly "c"/)
  })

  it('REFUSES A CLAIM WHOSE TEST IS SKIPPED, which a name grep could not tell', () => {
    // The reason this clause reads a structured report instead of grepping the file for
    // the name: a skipped test satisfies a grep and proves nothing. #124 one level up.
    expect(
      tests(clean(), [
        PASSED[0],
        PASSED[1],
        { fullName: 'the fixture > c', state: 'skipped', fails: false },
      ]).join(' '),
    ).toMatch(/is "skipped", not passed/)
  })

  it('REFUSES A CLAIM BOUND TO AN EXPECTED-FAILURE TEST', () => {
    // #223, and the clause that makes the register's central sentence true. `it.fails`
    // passes PRECISELY WHEN its assertion fails, and vitest's built-in JSON reporter
    // records it exactly like any other pass: status "passed", empty failureMessages,
    // empty meta and tags. So before this, a false claim could be registered as
    // `it.fails('the claim', () => expect(theClaimIsTrue).toBe(true))` and certified by a
    // test that succeeds only while the claim is false.
    expect(
      tests(clean(), [
        PASSED[0],
        PASSED[1],
        { fullName: 'the fixture > c', state: 'passed', fails: true },
      ]).join(' '),
    ).toMatch(/EXPECTED-FAILURE/)
  })

  it('refuses an expected-failure test even though its state is passed', () => {
    // The distinction worth pinning: `state` is "passed" in BOTH cases. If this clause
    // ever reads the state instead of the flag it will silently stop refusing.
    const out = tests(clean(), [
      PASSED[0],
      PASSED[1],
      { fullName: 'the fixture > c', state: 'passed', fails: true },
    ]).join(' ')
    expect(out).not.toMatch(/not passed/)
    expect(out).toMatch(/passes when the claim is false/)
  })

  it('refuses a claim whose name matches more than one test, as an ambiguous binding', () => {
    expect(
      tests(clean(), [
        ...PASSED,
        { fullName: 'a second describe > c', state: 'passed', fails: false },
      ]).join(' '),
    ).toMatch(/matches 2 tests/)
  })

  it('REFUSES A FRAGMENT OF A TEST NAME, which used to be accepted', () => {
    // THE #225 CASE. `expect` was matched with `.includes`, so a short string matched any
    // longer name — a claim could be satisfied by a test written for a different sentence.
    // Here the only test is named "a and then some", and the claim's expect is "a".
    expect(
      tests(clean(), [
        { fullName: 'the fixture > a and then some', state: 'passed', fails: false },
        PASSED[1],
        PASSED[2],
      ]).join(' '),
    ).toMatch(/no test is named exactly "a"/)
  })

  it('refuses a run it could not perform, rather than treating it as nothing found', () => {
    expect(tests(clean(), PASSED, true).join(' ')).toMatch(/could not run/)
  })

  it('refuses a report listing no tests at all', () => {
    expect(tests(clean(), []).join(' ')).toMatch(/lists no tests/)
  })
})

describe("a claim cannot lean on another claim's test, or on the bullet as a whole (#225)", () => {
  it('REFUSES TWO CLAIMS BOUND TO ONE TEST', () => {
    // The #219 review repointed one claim's binding at a neighbouring claim's test and both
    // checks stayed clean. "Registering a claim means writing a test" is the property that
    // makes this register more than paperwork, and without uniqueness it means "pointing at
    // somebody's test", which is the paperwork outcome.
    const r = clean()
    seg(r, 2).expect = seg(r, 1).expect
    expect(structure(r).join(' ')).toMatch(/is bound by 2 claims/)
  })

  it('refuses a first segment that carries body text along with the bold heading', () => {
    // Reconstruction cannot see this: the join still equals the document line. The heading
    // segment would simply be binding prose to the heading's test.
    const r = clean()
    seg(r, 0).text = '- **Alpha.** Beta.'
    seg(r, 1).text = ' Gamma.'
    bullet(r).segments = [seg(r, 0), seg(r, 1)]
    expect(structure(r).join(' ')).toMatch(/must be exactly "- \*\*Alpha\.\*\*"/)
  })

  it('REFUSES A BULLET HELD IN ONE SEGMENT, which reconstruction accepts', () => {
    // One segment holding the whole line rejoins perfectly, so clause 3 is satisfied while
    // every sentence in the bullet rests on a single test. That is the per-bullet design
    // #201 already disproved: "There is no direct write tool" is TRUE while the lifecycle
    // sentence beside it was FALSE.
    const r = clean()
    bullet(r).segments = [
      {
        kind: 'claim',
        text: '- **Alpha.** Beta. Gamma.',
        test: 'src/plans/plans.test.ts',
        expect: 'a',
      },
    ]
    expect(structure(r).join(' ')).toMatch(/the whole bullet is ONE segment/)
  })

  it('accepts the clean fixture, so none of the three above passes vacuously', () => {
    expect(structure(clean())).toEqual([])
  })
})

describe('the document is found in BOTH trees, not only the one we develop in', () => {
  /**
   * #132's class, and this one shipped before it was caught.
   *
   * The dev repository keeps the published set under `public/`; the assembler lifts it to
   * the ROOT of the published repository. So `public/docs/SAFETY.md` here is
   * `docs/SAFETY.md` there, and a register storing the dev path passes every local run
   * while failing the assembly. It did, on six consecutive pushes, with `cannot read
   * public/docs/SAFETY.md`.
   *
   * A dev-only test cannot catch that by construction, which is why these build a tree in
   * each layout and run the real script against both. The fixtures stop short of the
   * test-running clause on purpose: each register names a test file that does not exist,
   * so a run that READ the document fails on that instead, and "cannot read" is the
   * signal under test either way.
   */
  function tree(layout: 'dev' | 'public', docAt: string): { root: string; reg: string } {
    const root = mkdtempSync(join(tmpdir(), 'mp-layout-'))
    writeFileSync(join(root, '.manyportals-layout'), `${layout}\n`)
    mkdirSync(join(root, docAt.split('/').slice(0, -1).join('/')), { recursive: true })
    writeFileSync(join(root, docAt), DOC)
    const reg = join(root, 'register.json')
    writeFileSync(
      reg,
      JSON.stringify({
        exemptBaseline: 0,
        observedBaseline: 0,
        pendingBaseline: 0,
        pending: [],
        bullets: [
          {
            doc: 'docs/SAFETY.md',
            section: 'What it protects',
            heading: 'Alpha.',
            segments: [
              { kind: 'claim', text: '- **Alpha.**', test: 'src/absent.test.ts', expect: 'a' },
              { kind: 'claim', text: ' Beta.', test: 'src/absent.test.ts', expect: 'b' },
              { kind: 'claim', text: ' Gamma.', test: 'src/absent.test.ts', expect: 'c' },
            ],
          },
        ],
      }),
    )
    return { root, reg }
  }

  function run(root: string, reg: string): string {
    try {
      return execFileSync('node', ['scripts/claims-register.mjs'], {
        cwd: REPO,
        encoding: 'utf8',
        env: { ...process.env, CLAIMS_ROOT: root, CLAIMS_REGISTER_FILE: reg },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      const x = e as { stdout?: string; stderr?: string }
      return (x.stdout ?? '') + (x.stderr ?? '')
    }
  }

  it('resolves the document under public/ when the tree says dev', () => {
    const { root, reg } = tree('dev', 'public/docs/SAFETY.md')
    const out = run(root, reg)
    expect(out).not.toMatch(/cannot read/)
    // Proof it got PAST the read rather than skipping the bullet entirely.
    expect(out).toMatch(/test file that does not exist/)
  })

  it('resolves the document at the root when the tree says public', () => {
    const { root, reg } = tree('public', 'docs/SAFETY.md')
    const out = run(root, reg)
    expect(out).not.toMatch(/cannot read/)
    expect(out).toMatch(/test file that does not exist/)
  })

  it('still refuses when the document is genuinely absent for the declared layout', () => {
    // The control. Without it the two cases above would pass if "cannot read" were simply
    // never emitted any more.
    const { root, reg } = tree('public', 'public/docs/SAFETY.md')
    expect(run(root, reg)).toMatch(/cannot read/)
  })
})

describe('the script itself refuses, not just its parts', () => {
  it('exits non-zero on a register it cannot read', () => {
    const d = mkdtempSync(join(tmpdir(), 'mp-claims-'))
    const f = join(d, 'broken.json')
    writeFileSync(f, '{ not json')
    let rc = 0
    try {
      execFileSync('node', ['scripts/claims-register.mjs'], {
        cwd: REPO,
        encoding: 'utf8',
        env: { ...process.env, CLAIMS_REGISTER_FILE: f },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      rc = (e as { status?: number }).status ?? -1
    }
    expect(rc).toBe(1)
  })
})

/**
 * The allow-list over the governed section (#224, #234).
 *
 * Discovery used to keep lines starting `- **` and skip the rest, so the section's
 * contract held for one Markdown spelling and silently not for the others. Driven against
 * the real function on 2026-10-06, ELEVEN shapes put visible text under that heading
 * without being discovered. They are all here, and each is driven through
 * `checkStructure` rather than `bulletsIn`, because the question is not what discovery
 * RETURNS but whether the GATE REFUSES.
 *
 * Two of them are refused by a clause that already existed, and that is the design rather
 * than a gap: a continuation line and a nested bullet are ABSORBED into the item's source
 * span, so reconstruction sees a line that no longer matches its segments. The allow-list
 * only has to stop text escaping discovery; what happens next is the register's job.
 */
describe('the governed section takes one list and nothing else (#224)', () => {
  const section = (body: string) => `# D\n\n## What it protects\n\n${body}\n## Elsewhere\n`
  const ok = '- **Alpha.** Beta. Gamma.\n'

  it('accepts the one permitted shape', () => {
    expect(structure(clean(), { 'd.md': section(ok) })).toEqual([])
  })

  it.each([
    ['a continuation line', ok + '  a qualifying sentence\n', /do not rejoin/],
    ['a nested bullet indented with spaces', ok + '  - **Nested.** x\n', /do not rejoin/],
    ['a nested bullet indented with a tab', ok + '\t- **Nested.** x\n', /do not rejoin/],
    ['a bare paragraph', ok + '\nA stray sentence.\n', /holds a paragraph at line/],
    ['a blockquote', ok + '\n> **Quoted.** x\n', /holds a blockquote at line/],
    ['a table', ok + '\n| a | b |\n|---|---|\n| **T.** | y |\n', /holds a table at line/],
    ['a deeper heading', ok + '\n### More\n\n- **Hidden.** x\n', /holds a heading at line/],
    ['an alternate * marker', ok + '\n* **Star.** x\n', /separate lists/],
    ['an alternate + marker', ok + '\n+ **Plus.** x\n', /separate lists/],
    ['a numbered item', ok + '\n1. **Numbered.** x\n', /separate lists/],
    ['an item shifted one space', ok + ' - **Shifted.** x\n', /does not start/],
    ['an item with no bold opening', ok + '- Plain claim.\n', /neither registered nor pending/],
  ])('REFUSES %s', (_name, body, pattern) => {
    expect(structure(clean(), { 'd.md': section(body) }).join(' ')).toMatch(pattern)
  })

  it('refuses an ordered list, which cannot carry a "- " bullet at all', () => {
    const doc = section('1. **Alpha.** Beta. Gamma.\n')
    expect(structure(clean(), { 'd.md': doc }).join(' ')).toMatch(/ordered list/)
  })

  it('names the LINE of the stray, because a refusal that cannot be located is a puzzle', () => {
    // The paragraph is the fifth line of this fixture. A refusal that says only "there is
    // a paragraph somewhere under this heading" costs the reader the search this check
    // already did.
    expect(structure(clean(), { 'd.md': section('A stray sentence.\n\n' + ok) }).join(' ')).toMatch(
      /paragraph at line 5/,
    )
  })
})

/**
 * A FENCED EXAMPLE QUOTING THE SECTION USED TO REDIRECT THE WHOLE GATE (#234).
 *
 * Discovery located the section with `lines.findIndex((l) => l.trim() === '## ' + section)`,
 * and a line scan cannot tell a heading from a line of prose shaped like one. A fenced
 * block quoting the heading therefore won by coming first, and with a COMPLETE quoted copy
 * every clause passed while reading the code sample. The live bullets were never examined,
 * so the published page could then be falsified with this gate reporting clean. Proven
 * against the real register and the real page on 2026-10-06 before the fix was written.
 *
 * This is the input that makes the fix fire, and it has to assert that the refusal names
 * the LIVE text: a refusal that merely happens is not proof the right section was read.
 */
describe('a heading inside a code fence cannot redirect the gate (#234)', () => {
  const FENCE = '`'.repeat(3)
  const doc = [
    '# D',
    '',
    'An example of the format:',
    '',
    FENCE + 'markdown',
    '## What it protects',
    '',
    '- **Alpha.** Beta. Gamma.',
    FENCE,
    '',
    '## What it protects',
    '',
    '- **Alpha.** Beta. FALSIFIED.',
    '',
    '## Elsewhere',
    '',
  ].join('\n')

  it('REFUSES, reading the live section rather than the quoted copy', () => {
    const bad = structure(clean(), { 'd.md': doc }).join(' ')
    expect(bad).toMatch(/do not rejoin/)
    // Non-vacuity, and the whole point: the refusal quotes the LIVE line. Before the fix
    // this fixture reported clean, because every clause was reading the fenced copy.
    expect(bad).toMatch(/FALSIFIED/)
  })

  it('refuses two sections of the same name rather than picking one', () => {
    const two = doc.replace(FENCE + 'markdown\n', '').replace(FENCE + '\n', '')
    expect(structure(clean(), { 'd.md': two }).join(' ')).toMatch(/more than one/)
  })
})

/**
 * THE PARSER'S OWN RECONSTRUCTION CHECK (#224).
 *
 * Taking a Markdown parser makes the gate's SCOPE — which text must be registered — a
 * function of a third-party version, and that is this register's own failure mode one
 * level up. The answer is that the lexer's token `raw` values must rejoin the document
 * byte-for-byte before anything is read from them, so an upgrade that stops covering the
 * source REFUSES instead of quietly governing less.
 *
 * The real lexer always rejoins, which is exactly why this clause needs an injected one.
 * A clause whose input cannot be supplied cannot be proven able to fail (#124).
 */
describe('the Markdown lexer is held to the same reconstruction rule (#224)', () => {
  function withLexer(lexer: string): { fault?: string; bullets?: string[] } {
    const out = execFileSync(
      'node',
      [
        '--input-type=module',
        '-e',
        `import { bulletsIn } from ${JSON.stringify(MJS)}
         import { marked } from 'marked'
         const { text } = JSON.parse(process.argv[1])
         process.stdout.write(JSON.stringify(bulletsIn(text, 'What it protects', ${lexer})))`,
        JSON.stringify({ text: DOC }),
      ],
      { cwd: REPO, encoding: 'utf8' },
    )
    return JSON.parse(out) as { fault?: string; bullets?: string[] }
  }

  it('accepts the real lexer, so the case below is not passing vacuously', () => {
    const r = withLexer('undefined')
    expect(r.fault).toBeUndefined()
    expect(r.bullets).toEqual(['- **Alpha.** Beta. Gamma.'])
  })

  it('REFUSES A LEXER WHOSE TOKENS DO NOT COVER THE DOCUMENT', () => {
    // One token dropped. This is what an upgrade that stopped emitting a block would look
    // like, and without this clause it would shrink the governed region in silence.
    const r = withLexer('(t) => { const k = marked.lexer(t); k.pop(); return k }')
    expect(r.bullets).toBeUndefined()
    expect(r.fault).toMatch(/do not rejoin to the document/)
  })

  it('refuses a lexer that throws, rather than treating the failure as an empty document', () => {
    const r = withLexer('() => { throw new Error("lexer exploded") }')
    expect(r.bullets).toBeUndefined()
    expect(r.fault).toMatch(/cannot be parsed as Markdown/)
    expect(r.fault).toMatch(/lexer exploded/)
  })
})
