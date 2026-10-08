/**
 * claims-reporter.mjs — the per-test facts the claims register needs, which the built-in
 * JSON reporter does not carry (#223).
 *
 * WHY THIS EXISTS. `claims:check` used `--reporter=json` and accepted a test whose status
 * was "passed". A test written with `it.fails(...)` SUCCEEDS precisely when its assertion
 * fails, and the JSON reporter records it exactly like any other pass:
 *
 *     status: "passed"   failureMessages: []   meta: {}   tags: []
 *
 * Nothing in that report distinguishes it. So a false claim could be registered as
 * `it.fails('the claim', () => expect(theClaimIsTrue).toBe(true))`, and the register would
 * certify it — which falsifies the one sentence the whole mechanism rests on, that you
 * cannot register a false claim because a false claim's test fails.
 *
 * Measured on vitest 4 before being built: a reporter sees `test.options.fails`, and
 * `test.fullName` is the exact name rather than a title fragment. Both are written out
 * here, so the register can refuse an expected-failure test AND match names exactly
 * instead of by substring (#225).
 *
 * TO A FILE, not to stdout. Vitest's own output shares stdout, and a parser that has to
 * pick its data out of a stream shared with arbitrary test output is one escape sequence
 * away from reading the wrong thing. The register refuses when the file is absent or
 * empty, because a reporter that wrote nothing is indistinguishable from a run that
 * proved nothing.
 */
import { writeFileSync } from 'node:fs'

export default class ClaimsReporter {
  onTestRunEnd(testModules = []) {
    const out = []
    for (const m of testModules) {
      for (const t of m.children.allTests()) {
        out.push({
          fullName: t.fullName,
          state: t.result()?.state,
          // `fails: true` means the test is EXPECTED to fail, so its passing proves the
          // opposite of its name. Absent on an ordinary test.
          fails: t.options?.fails === true,
        })
      }
    }
    const path = process.env.CLAIMS_REPORT_FILE
    if (path === undefined) {
      // Refusing loudly beats writing somewhere nobody reads.
      throw new Error(
        'claims-reporter: CLAIMS_REPORT_FILE is not set, so there is nowhere to report',
      )
    }
    writeFileSync(path, out.map((o) => JSON.stringify(o)).join('\n') + '\n')
  }
}
