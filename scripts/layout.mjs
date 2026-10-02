/**
 * layout.mjs — which tree am I in? (#107)
 *
 * The node peer of scripts/layout.sh, reading the same declaration. See that file for
 * why the previous `existsSync('public')` test was unsafe: an empty directory named
 * `public` silently changed which files the shipped checks examined, and they reported
 * success while examining nothing.
 *
 * Throws rather than guessing. A wrong layout is a confident wrong answer.
 */
import { readFileSync } from 'node:fs'

export const LAYOUT_MARKER = '.manyportals-layout'

export function mpLayout(root = '.') {
  let raw
  try {
    raw = readFileSync(`${root}/${LAYOUT_MARKER}`, 'utf8')
  } catch {
    throw new Error(
      `no ${LAYOUT_MARKER} in ${root}, so which file set to scan is unknown. Refusing to ` +
        `guess: guessing is what made an empty directory named 'public' turn these checks off (#107).`,
    )
  }
  // The same normalisation layout.sh specifies, in the same order. `.trim()` is NOT it:
  // it follows Unicode whitespace, so it accepted a BOM and a non-breaking space that
  // the shell reader refused, while the shell reader accepted internal whitespace that
  // this one refused. Both directions were real (#127).
  const value = (raw.startsWith('\ufeff') ? raw.slice(1) : raw).replace(
    /^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g,
    '',
  )
  if (value !== 'dev' && value !== 'public') {
    throw new Error(`${LAYOUT_MARKER} says '${value}'; expected exactly 'dev' or 'public'.`)
  }
  return value
}
