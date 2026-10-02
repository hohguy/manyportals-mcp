/**
 * Small cross-cutting helpers shared across modules. Each lives here because it
 * was either duplicated or rebuilt ad hoc and a red-team round flagged it. Keep
 * this lean — generic utilities only, no domain logic.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Expand a LEADING `~` to the current user's home directory — `~/portals/config.json`
 * or a bare `~`, nothing else. Claude Desktop passes `user_config` values through
 * verbatim, so a path an operator typed with a `~` arrives literally and every fs
 * call on it fails as "not found or unreadable", which has already cost a real
 * onboarding attempt.
 *
 * Deliberately narrow. A `~` anywhere but the front is an ordinary path character,
 * and `~user` names a DIFFERENT user's home that we cannot resolve correctly — both
 * are returned untouched rather than guessed at. Shared by every path that comes in
 * from the environment, so the three env-var paths cannot drift apart.
 */
export function expandTilde(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Map over `items` with BOUNDED concurrency, preserving input order. Caps the
 * number of simultaneous `fn` calls so a wide fan-out cannot fire an N-wide burst
 * of HubSpot calls (the C3/F-R3.1 rate-limit hazard — L1). Fails fast: if any
 * `fn` rejects, the whole call rejects. To fail SOFT, have `fn` catch and return a
 * result object instead of throwing.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i]!, i)
    }
  }
  // Clamp the worker count to at least 1 (never 0): a caller passing limit <= 0 must
  // still run every item — sequentially — not silently no-op into a sparse result
  // array that downstream `.every()` reads as an all-pass. Capped at items.length.
  const concurrency = Math.min(Math.max(1, Math.floor(limit)), items.length)
  await Promise.all(Array.from({ length: concurrency }, worker))
  return results
}

/**
 * Compare two property values: numerically when BOTH parse as finite numbers,
 * else lexically. Used to order records by a timestamp property whose wire format
 * may be epoch-millis (numeric) or ISO-8601 (lexical) — so the production sort is
 * as robust as the test fake, not less (L2). Ascending; negate for descending.
 */
export function compareValues(a: string | undefined, b: string | undefined): number {
  const na = Number(a)
  const nb = Number(b)
  if (a !== undefined && b !== undefined && !Number.isNaN(na) && !Number.isNaN(nb)) {
    return na - nb
  }
  return String(a ?? '').localeCompare(String(b ?? ''))
}

/** Recursively freeze a value and its nested values so it cannot be mutated later. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}
