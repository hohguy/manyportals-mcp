#!/usr/bin/env node
/**
 * claims-register.mjs — every public safety assertion is bound to a test that can fail (#94).
 *
 * WHY A POINTER IS NOT ENOUGH. The ticket originally proposed that each claim cite the code
 * that enforces it. Checked against every instance that motivated it, a pointer would have
 * caught NONE: a pointer proves a target exists, and every failure here was a semantic
 * mismatch where the code exists and does something adjacent to what the sentence says.
 *
 * WHY THE UNIT IS NOT THE BULLET. The first replacement design registered one entry per
 * bullet. #201 is the counterexample: "There is no direct write tool" is TRUE, so a test
 * with that name passes while the same bullet's lifecycle sentence is FALSE. Registering
 * per bullet would have reproduced the exact class this file exists to catch.
 *
 * SO THE UNIT IS THE ASSERTION, and coverage is proven by RECONSTRUCTION rather than by
 * splitting prose. Each bullet's segments must rejoin to its line byte-for-byte. That is
 * strictly stronger than a sentence splitter, because a splitter's mistakes become the
 * check's blind spots: prose with backticks and abbreviations does not split reliably, and
 * every case it mishandles is a sentence nobody has to register. Reconstruction has no
 * such class. A sentence added, reworded or dropped all fail the join, and the failure
 * names itself.
 *
 * The real value is not this check. It is that YOU CANNOT REGISTER A FALSE CLAIM: doing so
 * means writing a test that asserts it, and a false claim's test fails. The 2026-10-05
 * audit found 17 defects behind these sentences, and found them by asking what a test
 * asserting each exact sentence would assert.
 *
 * THE THIRD KIND, `observed`. Three sentences on this page assert what a THIRD-PARTY
 * application does: that your MCP client prompts you before a destructive step, that
 * gating `execute_plan` in it is what stops the assistant, and what Claude Desktop shows
 * on its Local MCP servers screen. No test here can observe another application, and
 * `exempt` would be a lie, because each asserts something specific and safety-relevant.
 * Deleting them would make the page less true: the client-side gate is the real last line
 * of defence.
 *
 * Leaving those bullets permanently `pending` was the other option and is worse than it
 * looks. If three bullets can never be registered then `pendingBaseline` can never reach
 * zero, and pending becomes exactly the permanent allowance the ratchet exists to prevent.
 *
 * So an `observed` segment records WHAT was observed, the ISO DATE it was observed, and
 * HOW to re-check it. It is ratcheted like `exempt`, and the dates print on every clean
 * run, because an observation of someone else's software ages and nothing here will
 * notice. A date makes a statement honest; it does not make it current.
 *
 * TESTING: CLAIMS_REGISTER_FILE and CLAIMS_ROOT substitute the register and the tree, so
 * src/claims-register.test.ts can supply the inputs that make each clause fire. A guard
 * whose input cannot be supplied cannot be proven able to fail (#124).
 */
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { marked } from 'marked'
import { mpLayout } from './layout.mjs'

const ROOT = process.env.CLAIMS_ROOT ?? process.cwd()
/**
 * WHERE THE PUBLISHED DOCUMENTS LIVE, which is not the same path in both trees.
 *
 * In the dev repository the public set sits under `public/`; the assembler lifts it to the
 * ROOT of the published repository, so `public/docs/SAFETY.md` here is `docs/SAFETY.md`
 * there. The register therefore stores the PUBLIC-RELATIVE path and this resolves it.
 *
 * This was not hypothetical. The first version hardcoded the dev path, passed every local
 * run, and failed the assembly on six consecutive pushes with `cannot read
 * public/docs/SAFETY.md`. That is #132's class: a gate that behaves differently in the two
 * trees, which a dev-only test cannot catch by construction.
 *
 * It failed CLOSED, which is the only reason anyone found out. Had the read returned empty
 * and the bullet scan found nothing, the check would have reported clean in the published
 * tree forever while claiming to police it.
 */
const PUBLIC_ROOT = mpLayout(ROOT) === 'dev' ? join(ROOT, 'public') : ROOT
const REGISTER = process.env.CLAIMS_REGISTER_FILE ?? join(ROOT, 'scripts/claims-register.json')

/** The 1-based line of a byte offset, so a refusal can name a place rather than a shape. */
function lineAt(text, offset) {
  let n = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') n += 1
  return n
}

/**
 * Every top-level list item in the named section, or a REFUSAL.
 *
 * WHY A PARSER AND NOT A LINE SCAN (#224). This kept lines starting `- **` and SKIPPED
 * everything else, so the section's contract was enforced against one Markdown spelling
 * and silently not against the rest. Driven against the real function on 2026-10-06,
 * ELEVEN shapes put visible text in the governed section without being discovered: a
 * continuation line, a nested bullet under either indent, a `*` or `+` marker, an item
 * shifted one space, an item with no bold opening, an ordered item, a blockquote, a table
 * row, and a bare paragraph. Enumerating them is the wrong fix — Markdown has more
 * spellings than anyone will list. The ALLOW-LIST is the fix: one permitted structure,
 * everything else refused, and then the count stops mattering.
 *
 * AND THE LINE SCAN COULD BE REDIRECTED WHOLESALE (#234). `findIndex` on `## <section>`
 * cannot tell a heading from a line of prose that looks like one, so a fenced example
 * quoting the section won by being first. With a COMPLETE quoted copy every clause passed
 * while reading the code sample, the live bullets were never examined, and the published
 * page could then be falsified with this gate reporting clean. Proven against the real
 * register and the real page before this was written.
 *
 * WHY THE DEPENDENCY IS SAFE HERE, which was the standing objection to taking one: a
 * parser makes the gate's SCOPE — which text must be registered — a function of a
 * third-party version, and that is this register's own failure mode one level up. The
 * answer is the first clause below. marked's token `raw` values rejoin the whole document
 * byte-for-byte, so the parser gets the same reconstruction check the segments get, and an
 * upgrade that stops covering the source refuses instead of governing less.
 *
 * That proves COVERAGE, not classification: a version that reclassified a paragraph while
 * still rejoining would pass it. The allow-list and the eleven fixtures in
 * src/claims-register.test.ts are what cover classification.
 *
 * TESTING: the lexer is injectable, because the reconstruction clause below cannot be
 * reached with the real one — marked always rejoins. A clause whose input cannot be
 * supplied cannot be proven able to fail (#124), and this is the clause standing
 * between an upgraded parser and a silently smaller governed region.
 *
 * NOT A ReDoS SURFACE. marked's lexer is regex-based and has carried advisories of that
 * class. This lexes a committed document inside a dev/CI gate and never untrusted input.
 */
export function bulletsIn(text, section, lex = (t) => marked.lexer(t)) {
  let tokens
  try {
    tokens = lex(text)
  } catch (e) {
    return { fault: `the document cannot be parsed as Markdown: ${e?.message ?? 'unknown'}` }
  }

  // THE PARSER'S OWN RECONSTRUCTION CHECK, run before anything is read from its output.
  if (tokens.map((t) => t.raw).join('') !== text) {
    return {
      fault:
        `the Markdown lexer's tokens do not rejoin to the document, so what they cover is\n` +
        `      unknown and the governed region cannot be trusted. Refusing.`,
    }
  }

  const at = tokens.findIndex((t) => t.type === 'heading' && t.depth === 2 && t.text === section)
  // "Could not look" must never read as "found nothing" — the defect this codebase
  // refuses everywhere else (#108, #109). A renamed section is a refusal, not a clean run.
  if (at === -1) return { fault: `no section "## ${section}" in the document` }
  const again = tokens.findIndex(
    (t, i) => i > at && t.type === 'heading' && t.depth === 2 && t.text === section,
  )
  // Two sections of one name: the first would govern and the second would publish
  // unchecked. Which is meant is a question for a human, not a tie to break here.
  if (again !== -1) return { fault: `the document holds more than one "## ${section}" section` }

  // The section runs to the next heading of the SAME OR HIGHER level. A DEEPER heading is
  // still inside it and is refused below rather than ending it, because ending it there
  // would put every bullet beneath that subheading outside the governed region entirely.
  const body = []
  let offset = tokens.slice(0, at + 1).reduce((n, t) => n + t.raw.length, 0)
  for (let i = at + 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type === 'heading' && t.depth <= 2) break
    body.push({ token: t, offset })
    offset += t.raw.length
  }

  // THE ALLOW-LIST: one unordered `- ` list, blank lines, and nothing else.
  const stray = body.find(({ token }) => token.type !== 'list' && token.type !== 'space')
  if (stray) {
    return {
      fault:
        `section "## ${section}" holds a ${stray.token.type} at line ${lineAt(text, stray.offset)}, and this\n` +
        `      heading takes one list and nothing else. Every sentence under it is a published\n` +
        `      safety claim, so anything that is not a registered bullet is either a claim in\n` +
        `      disguise or a mistake. Move it above the heading, or make it a bullet and register it.`,
    }
  }
  const lists = body.filter(({ token }) => token.type === 'list')
  if (lists.length === 0) return { fault: `section "## ${section}" holds no list` }
  if (lists.length > 1) {
    return {
      fault:
        `section "## ${section}" holds ${lists.length} separate lists, the second at line ${lineAt(text, lists[1].offset)}.\n` +
        `      A changed marker or a numbered item starts a new list, and only one would be\n` +
        `      governed. Write the claims as a single "- " list.`,
    }
  }
  const list = lists[0]
  if (list.token.ordered) {
    return { fault: `section "## ${section}" holds an ordered list; claims are "- " bullets` }
  }

  const out = []
  let itemAt = list.offset
  for (const item of list.token.items) {
    if (!item.raw.startsWith('- ')) {
      return {
        fault:
          `section "## ${section}" holds a list item at line ${lineAt(text, itemAt)} that does not start\n` +
          `      with "- ". Claims are "- " bullets, and a different marker or an indent makes a\n` +
          `      sentence the register cannot bind.`,
      }
    }
    itemAt += item.raw.length
    // Trailing NEWLINES only. A loose list — one with a blank line between items — appends
    // them to the span, and that is cosmetic. Trailing SPACES are a Markdown hard break and
    // stay inside the byte-exact comparison, where a reader would see their effect.
    out.push(item.raw.replace(/\n+$/, ''))
  }
  if (out.length === 0) return { fault: `section "## ${section}" holds no bullet` }
  return { bullets: out }
}

/**
 * The `it()` title from a reporter's full name, which is "<describe> > <it>" (nested
 * describes add more). Claims match this EXACTLY rather than as a substring (#225): a short
 * `expect` used to match any longer name, so one test could satisfy a claim written about a
 * different sentence. Matching the whole `fullName` was the other option and was measured
 * first — it would have meant rewriting all 55 entries and filling the register with " > "
 * paths, where this migrated 26 and left it reading as sentences.
 *
 * A title containing " > " itself would split wrongly here. That fails CLOSED: the exact
 * comparison then finds nothing and the claim is refused, rather than matching too much.
 */
function testTitle(fullName) {
  const at = fullName.lastIndexOf(' > ')
  return at === -1 ? fullName : fullName.slice(at + 3)
}

/**
 * A real calendar day in YYYY-MM-DD, or undefined (#227).
 *
 * The shape test this replaced accepted `9999-99-99`, and `new Date('2026-02-31')` silently
 * rolls over to 2 March rather than failing. Round-tripping through the ISO string catches
 * both: a rolled-over date no longer prints as what was written.
 */
function isoDay(value) {
  const v = String(value ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined
  const d = new Date(`${v}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return undefined
  return d.toISOString().slice(0, 10) === v ? d : undefined
}

/** UTC midnight, so "dated in the future" does not depend on the hour a gate runs. */
function startOfDay(when) {
  return new Date(`${when.toISOString().slice(0, 10)}T00:00:00Z`)
}

/** The structural clauses. Returns a list of failure strings; empty means clean. */
export function checkStructure(register, readDoc, now = new Date()) {
  const bad = []
  const bullets = register?.bullets
  if (!Array.isArray(bullets) || bullets.length === 0) {
    return ['the register holds no bullets, so it proves nothing']
  }
  if (typeof register.exemptBaseline !== 'number') {
    return ['the register has no numeric exemptBaseline, so the escape hatch is unratcheted']
  }
  if (typeof register.observedBaseline !== 'number') {
    return ['the register has no numeric observedBaseline, so third-party claims are uncounted']
  }

  // KNOWN DEBT, counted. The nine bullets are corrected and bound one ticket at a time
  // (#201-#208), so a bullet may be declared PENDING rather than registered. Pending is
  // not an exemption: an exempt SEGMENT is a sentence that asserts nothing, while a
  // pending BULLET is one whose claims are real and not yet proven. It is visible project
  // state with a ticket attached, and it can only shrink.
  const pending = Array.isArray(register.pending) ? register.pending : []
  for (const q of pending) {
    if (!q.heading || !q.ticket)
      bad.push(`a pending entry needs a heading and a ticket: ${JSON.stringify(q)}`)
  }
  if (typeof register.pendingBaseline !== 'number') {
    return ['the register has no numeric pendingBaseline, so the debt is uncounted']
  }
  if (pending.length > register.pendingBaseline) {
    bad.push(
      `the register holds ${pending.length} pending bullet(s) and pendingBaseline says ${register.pendingBaseline}.\n` +
        `      Pending may only SHRINK. A new unregistered claim is a new claim nobody has proven.`,
    )
  }
  if (pending.length < register.pendingBaseline) {
    bad.push(
      `${register.pendingBaseline - pending.length} bullet(s) left pending — lower pendingBaseline to ${pending.length}.\n` +
        `      The ratchet only holds if the number follows the work down.`,
    )
  }

  // CLAUSE 1b — (test, expect) pairs are globally UNIQUE (#225). Without this every claim
  // could bind to ONE uniquely named passing test and the check would report clean. That is
  // the paperwork outcome the register exists to prevent: registering a claim would mean
  // pointing at somebody else's test instead of writing one. Demonstrated in the #219 review
  // by repointing one claim at a neighbour's test, after which both checks stayed clean.
  const pairs = new Map()
  for (const b of bullets) {
    for (const s of b.segments ?? []) {
      if (s.kind !== 'claim' || !s.test || !s.expect) continue
      const key = `${s.test}\u0000${s.expect}`
      pairs.set(key, [...(pairs.get(key) ?? []), b.heading])
    }
  }
  for (const [key, headings] of pairs) {
    if (headings.length < 2) continue
    const [file, name] = key.split('\u0000')
    bad.push(
      `${file}: "${name}" is bound by ${headings.length} claims (${headings.join('; ')}).\n` +
        `      One test cannot prove two different sentences. Write one test per claim.`,
    )
  }

  const byDoc = new Map()
  for (const b of bullets) {
    const key = `${b.doc}\u0000${b.section}`
    if (!byDoc.has(key)) byDoc.set(key, b)
  }

  // CLAUSE 1 — every bullet in the document appears in the register. The LOAD-BEARING one:
  // reconstruction only governs bullets the register already knows about, so without this a
  // whole new claim could be published unregistered.
  for (const [key, sample] of byDoc) {
    const [doc, section] = key.split('\u0000')
    const text = readDoc(doc)
    if (text === undefined) {
      bad.push(`cannot read ${doc}, so its bullets cannot be checked`)
      continue
    }
    const found = bulletsIn(text, section)
    if (found.fault) {
      bad.push(`${doc}: ${found.fault}`)
      continue
    }
    for (const line of found.bullets) {
      const registered = bullets.some((b) => b.doc === doc && line.startsWith(`- **${b.heading}**`))
      const deferred = pending.some((q) => line.startsWith(`- **${q.heading}**`))
      if (registered && deferred) {
        bad.push(
          `${doc}: "${line.slice(4, 44)}" is both registered and pending — pending would silence it`,
        )
      }
      if (!registered && !deferred) {
        bad.push(
          `${doc}: this bullet is neither registered nor pending: ${line.slice(0, 68)}...\n` +
            `      Register it, or add it to "pending" with the ticket that will.`,
        )
      }
    }
    void sample
  }

  let exempt = 0
  let observed = 0
  for (const b of bullets) {
    const where = `${b.doc} "${b.heading}"`
    const segs = b.segments
    if (!Array.isArray(segs) || segs.length === 0) {
      bad.push(`${where}: no segments`)
      continue
    }

    // CLAUSE 2 — the heading rule. Bold text is written to be read alone, so it carries
    // its own test or it gets reworded. A heading whose body qualifies it four sentences
    // later is still an overclaim to a reader who stops at the bold.
    // CLAUSE 2b — and the first segment must BE the bold heading, exactly (#225). The kind
    // check below stops a heading resting on an exemption; this stops the heading segment
    // quietly carrying body text with it, which would bind prose to the heading's test.
    if (segs[0].text !== `- **${b.heading}**`) {
      bad.push(
        `${where}: the first segment must be exactly "- **${b.heading}**", not ` +
          `${JSON.stringify(String(segs[0].text).slice(0, 56))}`,
      )
    }
    if (segs[0].kind !== 'claim') {
      // Covers `observed` too: a heading resting on someone else's software is a heading
      // this project cannot stand behind, and it should be reworded rather than annotated.
      bad.push(
        `${where}: the first segment must be a claim, not "${segs[0].kind}" — a bold heading is read alone`,
      )
    }

    const text = readDoc(b.doc)
    if (text === undefined) continue
    const found = bulletsIn(text, b.section)
    if (found.fault) continue
    const line = found.bullets.find((l) => l.startsWith(`- **${b.heading}**`))
    if (line === undefined) {
      bad.push(`${where}: no bullet in the document starts with this heading`)
      continue
    }

    // CLAUSE 3 — RECONSTRUCTION.
    const joined = segs.map((s) => s.text ?? '').join('')
    if (joined !== line) {
      bad.push(
        `${where}: the segments do not rejoin to the document line.\n` +
          `      register: ${joined}\n` +
          `      document: ${line}`,
      )
    }

    // CLAUSE 3b — a bullet WITH A BODY is more than one segment (#225). A single segment
    // holding the whole line satisfies reconstruction trivially, and reconstruction cannot
    // see the difference: the join matches either way. That would make the register's unit
    // the bullet again, which is the design #201 already disproved — one true sentence in a
    // bullet whose next sentence is false.
    if (segs.length === 1 && line !== `- **${b.heading}**`) {
      bad.push(
        `${where}: the whole bullet is ONE segment, so every sentence in it rests on one test.\n` +
          `      Split it. The register's unit is the assertion, not the bullet.`,
      )
    }

    for (const s of segs) {
      if (s.kind === 'exempt') {
        exempt += 1
        if (!s.why)
          bad.push(`${where}: an exempt segment with no reason: ${String(s.text).slice(0, 48)}`)
        continue
      }
      if (s.kind === 'observed') {
        observed += 1
        // WHAT, and HOW TO CHECK IT AGAIN. A dateless observation is indistinguishable from
        // a guess, and one with no re-check instruction leaves the reader nothing to do
        // about the fact that it ages.
        if (!s.what) bad.push(`${where}: an observed segment must say WHAT was observed`)
        if (!s.recheck) bad.push(`${where}: an observed segment must say how to re-check it`)

        // WHICH SOFTWARE, AND WHICH BUILD OF IT (#227). "Claude Desktop masks the field" is
        // not a fact about Claude Desktop, it is a fact about one version of it: the same
        // field was plain text on 2026-09-15 and masked on 2026-10-06, three weeks apart.
        // Without a version the observation cannot be reproduced or retired, and the reader
        // cannot tell whether it describes the build they are running.
        //
        // The version may be the literal string "unknown" where it genuinely cannot be
        // recovered, which is the honest record for an observation made before anyone
        // thought to note it. Omitting the field is what is refused, because an absent
        // version is indistinguishable from an unrecorded one, while "unknown" is a
        // declared weakness that prints on every clean run.
        if (!s.client) bad.push(`${where}: an observed segment must name the CLIENT observed`)
        if (!s.clientVersion) {
          bad.push(
            `${where}: an observed segment must name the client VERSION, or "unknown" if it\n` +
              `      genuinely cannot be recovered. An absent version reads as an unrecorded one.`,
          )
        }

        // ONE OBSERVATION PER SEGMENT (#227). The compound this replaced held three
        // sentences, and the middle one — "ManyPortals declares the field sensitive" — was a
        // claim about THIS project's own manifest, bound to nothing, carrying a date and a
        // re-check instruction that were measured for somebody else's user interface.
        //
        // WHY A SENTENCE SPLIT IS ACCEPTABLE HERE while this file's header rejects one for
        // coverage: a splitter's mistakes become blind spots only when the splitter DEFINES
        // what must be covered. Coverage is still proven by reconstruction. This is a style
        // rule on one segment, so a missed split under-enforces and a wrong split is a loud
        // refusal that a human resolves by splitting the segment — which is the wanted
        // outcome either way.
        const sentences = String(s.text ?? '')
          .trim()
          .split(/(?<=[.!?])\s+(?=[A-Z`])/)
          .filter((p) => p !== '')
        if (sentences.length > 1) {
          bad.push(
            `${where}: an observed segment holds ${sentences.length} sentences. One observation,\n` +
              `      one date, one re-check. Split it, and bind anything testable as a claim.`,
          )
        }

        // THE DATES. Shape alone accepted 9999-99-99 and 2026-02-31.
        const observedOn = isoDay(s.date)
        if (observedOn === undefined) {
          bad.push(
            `${where}: an observed segment needs a real calendar date in YYYY-MM-DD, got "${String(s.date)}"`,
          )
        } else if (observedOn.getTime() > startOfDay(now).getTime()) {
          // A future observation was not made. This refusal can only go from red to green as
          // time passes, which is the safe direction: it never reddens an unchanged repository.
          bad.push(`${where}: an observed segment is dated in the future ("${String(s.date)}")`)
        }
        const recheckBy = isoDay(s.recheckBy)
        if (recheckBy === undefined) {
          bad.push(
            `${where}: an observed segment needs recheckBy as a real calendar date, got "${String(s.recheckBy)}"`,
          )
        } else if (observedOn !== undefined && recheckBy.getTime() <= observedOn.getTime()) {
          bad.push(`${where}: recheckBy "${String(s.recheckBy)}" is not after the observation date`)
        }
        // DELIBERATELY NOT CHECKED: whether recheckBy has passed. `verify` must not fail
        // with the passage of time and no change to the repository — a gate that reddens on a
        // Tuesday because nobody looked at a vendor's UI gets disabled rather than satisfied,
        // which is the argument that kept the absolute-quantifier prose lint out of #94.
        // recheckBy is DATA for the scheduled report in #213 to read, not a condition here.
        continue
      }
      if (s.kind !== 'claim') {
        bad.push(`${where}: unknown kind "${s.kind}" — use claim, exempt or observed`)
        continue
      }
      if (!s.test || !s.expect) {
        bad.push(`${where}: a claim with no test or no expect: ${String(s.text).slice(0, 48)}`)
        continue
      }
      // CLAUSE 4 — the named test file must exist.
      if (!existsSync(resolve(ROOT, s.test))) {
        bad.push(`${where}: names a test file that does not exist: ${s.test}`)
      }
    }
  }

  // CLAUSE 5 — the exemption ratchet, same shape as REFUSAL_BASELINE. The instruction and
  // narrative classifications are how a false claim gets reclassified instead of tested, so
  // the hatch cannot widen without someone being told.
  if (observed !== register.observedBaseline) {
    bad.push(
      `the register holds ${observed} observed segment(s) and observedBaseline says ${register.observedBaseline}.\n` +
        `      Do not just change the number. An observed segment is an assertion about software\n` +
        `      this project does not control, so each one is a decision about what to put your\n` +
        `      name to without being able to prove it.`,
    )
  }
  if (exempt !== register.exemptBaseline) {
    bad.push(
      `the register holds ${exempt} exempt segment(s) and exemptBaseline says ${register.exemptBaseline}.\n` +
        `      Do not just change the number. An exemption is a sentence nobody has to prove,\n` +
        `      so each one is a decision: say why in the segment's "why", then move the baseline.`,
    )
  }
  return bad
}

/**
 * Run one test FILE and return its per-test assertions, or throw.
 *
 * Separated from the clause below and injectable, so the clause's own failures — a name
 * matching nothing, a name matching two tests, a SKIPPED test — can each be given their
 * input without a real vitest run in a fixture tree. A fixture tree has no node_modules,
 * which is how an isolated worktree broke the artifact build earlier in this cohort. Same
 * reasoning as RELEASE_GATE_CMD in scripts/release-gate.sh.
 */
export function runTestFile(file, root = ROOT) {
  // One run per FILE, not per claim: a claim needs only "this named test passed", and the
  // per-test statuses in one report answer all of them. guard-register.mjs runs per entry
  // because each mutation needs its own run; this does not.
  //
  // THROUGH scripts/claims-reporter.mjs, NOT `--reporter=json` (#223). The built-in JSON
  // reporter records an `it.fails` test exactly like any other pass — status "passed",
  // empty failureMessages, empty meta and tags — so a claim could be registered as
  // `it.fails('the claim', ...)` and certified by a test that SUCCEEDS WHEN THE CLAIM IS
  // FALSE. Measured, not assumed: the probe is in the reporter's header. The custom
  // reporter writes the one fact that distinguishes them.
  const dir = mkdtempSync(join(tmpdir(), 'mp-claims-'))
  const report = join(dir, 'report.jsonl')
  try {
    // NODE AND VITEST'S OWN ENTRY, not `npx`. On Windows `npx` is `npx.cmd`, which
    // `CreateProcess` cannot resolve without a shell, so `execFileSync('npx', ...)` failed
    // with `spawnSync npx ENOENT` for every claim and the register refused the whole run.
    //
    // THE OBVIOUS FIX WAS THE WRONG ONE TO COPY. `guard-register.mjs:90` selects
    // `npx.cmd` on win32 and its Windows leg is green, which looks like proof. It is not:
    // that script SKIPS on Windows entirely (`:563`, #96), so its win32 branch has never
    // run. Invoking the package's own entry with `process.execPath` needs no shell, no
    // `.cmd` shim and no PATH lookup on any platform.
    const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs')
    if (!existsSync(vitest)) {
      // Could not look. A missing runner must not read as a satisfied claim.
      throw new Error(`cannot find vitest at ${vitest} — run npm ci in this tree`)
    }
    execFileSync(
      process.execPath,
      [vitest, 'run', file, '--reporter=./scripts/claims-reporter.mjs'],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, CLAIMS_REPORT_FILE: report },
      },
    )
    // An absent or empty report is a refusal rather than an empty result: a reporter that
    // wrote nothing is indistinguishable from a run that proved nothing.
    return readFileSync(report, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** CLAUSE 6 — every claim's test RAN and PASSED, read per-test from a structured report. */
export function checkTestsPassed(register, runFile = runTestFile) {
  const bad = []
  const byFile = new Map()
  for (const b of register.bullets) {
    for (const s of b.segments ?? []) {
      if (s.kind !== 'claim' || !s.test || !s.expect) continue
      if (!byFile.has(s.test)) byFile.set(s.test, [])
      byFile.get(s.test).push({ ...s, heading: b.heading })
    }
  }
  for (const [file, claims] of byFile) {
    let assertions
    try {
      assertions = runFile(file)
    } catch (e) {
      // Could not look. Never a pass.
      bad.push(`${file}: could not run or could not read a report (${e?.message ?? 'unknown'})`)
      continue
    }
    if (!Array.isArray(assertions) || assertions.length === 0) {
      bad.push(`${file}: the report lists no tests, so nothing was proven`)
      continue
    }
    for (const c of claims) {
      const hits = assertions.filter((a) => testTitle(a.fullName ?? '') === c.expect)
      // Zero is a refusal, not a pass: a renamed test must not read as a satisfied claim.
      if (hits.length === 0) {
        bad.push(`${file}: no test is named exactly "${c.expect}" (claim under "${c.heading}")`)
        continue
      }
      // More than one means the binding is ambiguous, so nobody can say which test proves
      // the sentence. That is a register defect, not a test defect.
      if (hits.length > 1) {
        bad.push(`${file}: "${c.expect}" matches ${hits.length} tests — make the name identify one`)
        continue
      }
      // AN EXPECTED-FAILURE TEST PROVES THE OPPOSITE OF ITS NAME (#223). `it.fails` passes
      // precisely when its assertion fails, so binding a claim to one certifies that the
      // claim is FALSE. This is the clause that makes "you cannot register a false claim"
      // true, and before it that sentence was simply wrong.
      if (hits[0].fails === true) {
        bad.push(
          `${file}: the test for "${c.expect}" is an EXPECTED-FAILURE test (it.fails), so it\n` +
            `      passes when the claim is false. A claim cannot be bound to one.`,
        )
        continue
      }
      // A SKIPPED test does not satisfy a claim, and a name grep could not tell.
      if (hits[0].state !== 'passed') {
        bad.push(`${file}: the test for "${c.expect}" is "${hits[0].state}", not passed`)
      }
    }
  }
  return bad
}

function main() {
  let register
  try {
    register = JSON.parse(readFileSync(REGISTER, 'utf8'))
  } catch (e) {
    console.error(`claims-register: FATAL — cannot read ${REGISTER}: ${e?.message ?? 'unknown'}`)
    process.exit(1)
  }
  const readDoc = (p) => {
    try {
      return readFileSync(resolve(PUBLIC_ROOT, p), 'utf8')
    } catch {
      return undefined
    }
  }
  const bad = [...checkStructure(register, readDoc)]
  if (bad.length === 0) bad.push(...checkTestsPassed(register))

  const claims = register.bullets.flatMap((b) =>
    (b.segments ?? []).filter((s) => s.kind === 'claim'),
  )
  if (bad.length > 0) {
    console.error('claims-register: FAILED')
    for (const b of bad) console.error(`  x ${b}`)
    process.exit(1)
  }
  const obs = register.bullets.flatMap((b) =>
    (b.segments ?? []).filter((s) => s.kind === 'observed'),
  )
  const pend = (register.pending ?? []).length
  console.log(
    `claims-register: clean — ${claims.length} claim(s) bound to a passing test across ` +
      `${register.bullets.length} bullet(s), ${register.exemptBaseline} exempt, ` +
      `${register.observedBaseline} observed, ${pend} bullet(s) pending`,
  )
  if (pend > 0) {
    for (const q of register.pending) console.log(`    pending: ${q.heading}  (${q.ticket})`)
  }
  // Printed on every CLEAN run, not only on failure. An observation of another vendor's
  // software goes stale silently, and the only defence this gate has is putting the date
  // in front of whoever walks past it.
  // The CLIENT and its VERSION print beside the date, because "Claude Desktop masks the
  // field" is a fact about one build of it and the reader cannot tell which build they have
  // otherwise (#227). recheckBy prints too, and NOTHING here compares it to today: `verify`
  // must not redden with the passage of time. #213's scheduled report is what reads it.
  for (const o of obs) {
    console.log(
      `    observed ${o.date} on ${o.client} ${o.clientVersion}, re-check by ${o.recheckBy}`,
    )
    console.log(`      ${o.what}`)
    console.log(`      how: ${o.recheck}`)
  }
}

// ENTRY-POINT TEST, and it must not be hand-rolled. This read
//
//   import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''))
//
// which strips up to the last FORWARD slash. On Windows `process.argv[1]` is
// `C:\path\scripts\claims-register.mjs`, so nothing was stripped, the comparison was
// false, and `main()` NEVER RAN. `npm run claims:check` exited 0 having checked nothing,
// and `verify` read that as a pass: a shipped gate reporting success by not executing,
// which is the defect this register exists to make impossible, in the register itself.
//
// Unseen because the cross-platform legs run only on a dispatch, and this was the first
// dispatch since the register was built. `guard-register.mjs` has used the form below
// since it was written and its Windows leg has been green, so the form is proven rather
// than guessed.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
