// command-paths.mjs — a command that ships must not name a file that does not.
//
// WHY THIS EXISTS. `.github/workflows/ci.yml` shipped a job whose only step ran
// `bash scripts/publish-sync.sh`, and that assembler is deliberately never published:
// it carries the allowlist and the names of the private paths. So the assembled public
// repository held a CI job that exits 127 on every push, and one `package.json` script
// named the same absent file. The job's own comment cited RT-15, "a CI workflow shipped
// whose script was never copied", as the thing it existed to prevent. The defect sat
// inside the job designed to catch it, and could not catch itself because it only ever
// ran where the missing file is present (#114, #121).
//
// WHAT IT CHECKS. For every workflow under .github/workflows and every entry in
// package.json's `scripts`, each repository-relative executable or script path the
// command names must exist in this tree as a regular file. `bash`, `npm`, `node` and
// `npx` are external commands, present in no tree, so they are not paths and are not
// checked.
//
// TWO LAYOUTS, ONE RULE, AND THE ONE THAT MATTERS IS THE SECOND. Run in the development
// repo it proves the commands name files that exist here, which catches a rename or a
// typo before a push. Run in the assembled public tree it proves the published
// repository is not broken on arrival, and that is the reason it exists. Only the
// assembled tree can answer it: the dev tree holds the private files, so `npm run
// verify` HERE passes while the class is live. Assembly refuses a dirty tree, so it
// cannot be folded into verify either. The assembler therefore runs this check itself,
// against the staged tree, before it commits, on every assembly including --no-verify;
// and the shipped `verify` runs it again inside that tree and in the public repo's own
// CI.
//
// WHAT IT DOES NOT COVER, so the gaps are on the record rather than implied:
//   - Data files a command reads (tsconfig.build.json, package-lock.json). The property
//     is about executables and scripts. A missing config fails loudly on first use; a
//     missing script is a 127 in a job nobody reads.
//   - Paths assembled at run time (`${TMPDIR:-/tmp}/x`, `${{ runner.temp }}/y`) and
//     paths inside an inline `node -e` program. Neither is a literal repository path.
//   - Anything under a generated directory: `npm run build` writes dist/ at the END of
//     verify, so it is legitimately absent while this runs. Those references are counted
//     and named rather than passed over in silence.
//   - `uses:` steps. Those name actions, not repository paths. A local composite action
//     would be a repository path, and there are none; a `./`-prefixed token inside a
//     `run:` command IS checked.
//   - Whether a workflow's YAML is valid, or whether its job is ever scheduled. That is
//     GitHub's to say, not this file's.
//   - A full-line shell comment inside a `run:` block is stripped before scanning, the
//     way idiom-check.sh strips comment lines: a file that DESCRIBES a path must not
//     trip the check that enforces it. A trailing comment on a command line is not
//     stripped, because telling one from a quoted `#` needs a shell parser.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const WORKFLOW_DIR = '.github/workflows'

// Directories this repository generates rather than tracks. `dist` is the build output,
// produced by the last step of verify, so `node -e "...chmodSync('dist/index.js')"` names
// a path that is correctly absent while this check runs. publish-sync.sh's package.json
// files[] check makes the same exception for the same reason.
const GENERATED = ['dist/']

// The extensions that make a token an executable script rather than data. A token has to
// be REPOSITORY-RELATIVE to be checkable at all, so the lookbehind rejects one preceded
// by `/` (absolute), `$` (interpolated), `~` (a home path) or another path character.
const SCRIPT_EXT = ['sh', 'bash', 'mjs', 'cjs', 'js', 'ts', 'py']
const PATH_RE = new RegExp(
  `(?<![\\w./$~{@-])((?:\\./)?(?:[\\w.@-]+/)+[\\w.@-]+\\.(?:${SCRIPT_EXT.join('|')}))(?![\\w/.-])`,
  'g',
)

const problems = []
const inputs = []

/**
 * The `run:` commands in one workflow, inline and block-scalar forms.
 *
 * Deliberately not a YAML parse: this repository takes no new dependency for a gate, and
 * the whole of what is needed is "the text of every run step". Only `run:` bodies are
 * read, never comments or `uses:` lines, because the property is about what the job
 * EXECUTES.
 */
function runCommands(text) {
  const out = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*(?:-\s+)?)run:[ \t]*(.*)$/.exec(lines[i])
    if (m === null) continue
    const keyColumn = m[1].length
    const inline = m[2].trim()
    // `|`, `>`, `|-`, `>+` and friends introduce a block; anything else on the line IS
    // the command.
    if (inline !== '' && !/^[|>][-+]?\d*$/.test(inline)) {
      out.push(inline)
      continue
    }
    const body = []
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') {
        body.push('')
        i = j
        continue
      }
      const indent = /^[ \t]*/.exec(lines[j])[0].length
      if (indent <= keyColumn) break
      body.push(lines[j].trim())
      i = j
    }
    out.push(body.join('\n'))
  }
  return out
}

/**
 * File-valued `with:` inputs in one workflow.
 *
 * WHY THIS IS HERE AND NOT COVERED BY runCommands. `run:` bodies are what a job EXECUTES,
 * and that is the property above. An action INPUT can also name a repository file —
 * `node-version-file: .node-version` is the first one here — and such a reference is
 * exactly as able to point at something the publish allowlist never copied. That is the
 * defect this whole file exists to prevent, arriving through a door it did not watch.
 *
 * Found while adding `.node-version` for #236: `commands:check` reported clean on a shipped
 * workflow naming a file that was not shipped. PATH_RE would not have matched it either,
 * since it only recognises script extensions.
 *
 * Keys ending `-file` are the ones that take a path, which keeps this narrow: it does not
 * guess that every string in a `with:` block is a filename.
 */
function fileInputs(text) {
  const out = []
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue
    const m = /^\s*([a-z0-9-]*-file):[ \t]*(['"]?)([^'"#\s]+)\2\s*(?:#.*)?$/i.exec(line)
    if (m === null) continue
    // An expression rather than a literal path cannot be checked from here.
    if (m[3].includes('${{')) continue
    out.push(m[3])
  }
  return out
}

/** Every repository-relative script path a command names, with comment lines dropped. */
function pathsIn(command) {
  const code = command
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
  return [...code.matchAll(PATH_RE)].map((m) => m[1].replace(/^\.\//, ''))
}

function workflowFiles() {
  let names
  try {
    names = readdirSync(WORKFLOW_DIR)
  } catch (e) {
    problems.push(`cannot read ${WORKFLOW_DIR} (${e.code ?? e.message}), so failing closed`)
    return []
  }
  return names.filter((n) => /\.ya?ml$/.test(n)).map((n) => join(WORKFLOW_DIR, n))
}

/** [{ source, command }] for every workflow run step and every package.json script. */
function shippedCommands() {
  const commands = []
  const files = workflowFiles()
  if (files.length === 0 && problems.length === 0) {
    problems.push(`no workflow files under ${WORKFLOW_DIR}, so nothing was examined`)
  }
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (e) {
      problems.push(`cannot read ${file} (${e.code ?? e.message}), so failing closed`)
      continue
    }
    for (const command of runCommands(text)) commands.push({ source: file, command })
    for (const named of fileInputs(text)) inputs.push({ source: file, path: named })
  }
  if (files.length > 0 && commands.length === 0) {
    problems.push(
      `no run: step was found in ${files.length} workflow file(s). Either the workflows ` +
        `stopped running commands, or this check stopped reading them. It must not report ` +
        `clean without saying which.`,
    )
  }

  let pkg
  try {
    pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  } catch (e) {
    problems.push(`cannot read package.json (${e.code ?? e.message}), so failing closed`)
    return commands
  }
  const scripts = Object.entries(pkg.scripts ?? {})
  if (scripts.length === 0) {
    problems.push('package.json declares no scripts, so nothing was examined')
  }
  for (const [name, command] of scripts) {
    commands.push({ source: `package.json scripts.${name}`, command })
  }
  return commands
}

const commands = shippedCommands()
const refs = []
const generated = []
for (const { source, command } of commands) {
  for (const path of pathsIn(command)) {
    if (GENERATED.some((prefix) => path.startsWith(prefix))) {
      generated.push({ source, path })
      continue
    }
    refs.push({ source, path })
  }
}

if (refs.length === 0 && problems.length === 0) {
  problems.push(
    `not one of ${commands.length} shipped command(s) named a repository-relative script ` +
      `path. That is either a real change or a broken extractor, and this check cannot ` +
      `tell you it passed without knowing which.`,
  )
}

for (const { source, path } of refs) {
  if (!existsSync(path)) {
    problems.push(`${source}: runs ${path}, which is not in this tree`)
    continue
  }
  if (!statSync(path).isFile()) {
    problems.push(`${source}: runs ${path}, which is not a regular file`)
  }
}

for (const { source, path } of inputs) {
  if (!existsSync(path)) {
    problems.push(`${source}: names ${path} as a file input, which is not in this tree`)
    continue
  }
  if (!statSync(path).isFile()) {
    problems.push(`${source}: names ${path} as a file input, which is not a regular file`)
  }
}

if (problems.length > 0) {
  console.error('command-paths: FAILED')
  for (const p of problems) console.error(`  ✗ ${p}`)
  console.error('  A published repository whose CI job cannot find its own script is broken')
  console.error('  on arrival, and nothing downstream of the publish can tell you (#121).')
  process.exit(1)
}
console.log(
  `command-paths: clean — ${refs.length} repository-relative path(s) named by ` +
    `${commands.length} shipped command(s), and ${inputs.length} file input(s), all exist`,
)
for (const { source, path } of generated) {
  console.log(`      · ${source}: ${path} not checked, it is generated by the build`)
}
