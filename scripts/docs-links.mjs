// Check the links between the published documents: every relative link must point at a
// file that exists, and every #anchor must match a heading in that file.
//
// This exists because a documentation reorganisation renamed headings and silently broke
// seven links in four files. They were repaired by hand; this stops the next reorganisation
// needing that. Anchors are derived the way GitHub derives them: lowercase, drop anything
// that is not a letter, digit, space or hyphen, then spaces to hyphens.
//
// Two layouts, one rule set: authored under public/ in the development repo, and at the
// root of the assembled public repo, where `npm run verify` also runs. Which one is read
// from the tree's own declaration rather than sniffed for a directory named `public`,
// because an empty directory of that name used to redirect this check at an empty tree
// and report success (#107).
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { mpLayout } from './layout.mjs'

const root = mpLayout('.') === 'dev' ? 'public' : '.'
const skip = new Set(['node_modules', '.git', 'dist', 'build'])

function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (skip.has(e.name)) return []
    const p = join(dir, e.name)
    if (e.isDirectory()) return markdownFiles(p)
    return e.name.endsWith('.md') ? [p] : []
  })
}

const slug = (heading) =>
  heading
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .replace(/ +/g, '-')

const anchorsOf = (file) =>
  new Set(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => /^#{1,6} /.test(l))
      .map((l) => slug(l.replace(/^#+ /, ''))),
  )

const files = markdownFiles(root)
if (files.length === 0) {
  console.error('docs-links: no markdown files found')
  process.exit(1)
}

const problems = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  // [text](target): external schemes and root-relative paths are out of scope.
  for (const [, target] of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue
    // A bare #anchor points inside this same file. Skipping those certified them falsely
    // (review 2026-09-27), so they are checked against this file's own headings.
    if (target.startsWith('#')) {
      if (!anchorsOf(file).has(target.slice(1))) {
        problems.push(`${file}: no heading matches ${target} in this file`)
      }
      continue
    }
    const [path, anchor] = target.split('#')
    let resolved = resolve(dirname(file), path)
    // In the development repo, some published files are not under public/: publish-sync
    // copies LICENSE, NOTICE and the example configs in from the repo root at assembly
    // time. So a target missing here is retried against the root before it counts as
    // broken. In the assembled repo the first attempt already succeeds.
    if (!existsSync(resolved) && root === 'public') {
      const fromRoot = resolve('.', path)
      if (existsSync(fromRoot)) resolved = fromRoot
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      problems.push(`${file}: link to a file that does not exist: ${target}`)
      continue
    }
    if (anchor && resolved.endsWith('.md') && !anchorsOf(resolved).has(anchor)) {
      problems.push(`${file}: no heading matches #${anchor} in ${relative('.', resolved)}`)
    }
  }
}

if (problems.length > 0) {
  console.error('docs-links: broken links in the published documents:')
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
console.log(
  `docs-links: clean — every relative link and #anchor in ${files.length} document(s) resolves`,
)
