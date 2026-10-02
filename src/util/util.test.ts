import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expandTilde, mapBounded } from './index.js'

describe('expandTilde', () => {
  it('expands a leading ~/ to the home directory', () => {
    // path.join (not string concat) so the expectation holds on Windows too.
    expect(expandTilde('~/portals/config.json')).toBe(join(homedir(), 'portals', 'config.json'))
  })

  it('expands a bare ~ to the home directory', () => {
    expect(expandTilde('~')).toBe(homedir())
  })

  it('does NOT expand a ~ in the middle of a path', () => {
    // A tilde anywhere but the front is an ordinary path character.
    const middle = join('/tmp', 'a~b', 'config.json')
    expect(expandTilde(middle)).toBe(middle)
    expect(expandTilde('/tmp/~/config.json')).toBe('/tmp/~/config.json')
  })

  it('does NOT expand ~user — that is another user’s home, which we cannot resolve', () => {
    expect(expandTilde('~someone/portals/config.json')).toBe('~someone/portals/config.json')
    expect(expandTilde('~someone')).toBe('~someone')
  })

  it('leaves an absolute path unchanged', () => {
    const absolute = join(homedir(), 'portals', 'config.json')
    expect(expandTilde(absolute)).toBe(absolute)
  })
})

describe('mapBounded', () => {
  it('processes EVERY item even when limit <= 0 (no silent no-op / sparse array)', async () => {
    // A caller passing 0/negative must still run every item (sequentially), not
    // no-op into a holey result that a downstream `.every()` reads as all-pass.
    const out = await mapBounded([1, 2, 3, 4, 5], 0, async (n) => n * 2)
    expect(out).toEqual([2, 4, 6, 8, 10])
  })

  it('handles a negative limit the same way (clamped to 1)', async () => {
    const out = await mapBounded([1, 2, 3], -5, async (n) => n)
    expect(out).toEqual([1, 2, 3])
  })

  it('returns [] for empty items regardless of limit', async () => {
    expect(await mapBounded([], 6, async (n: number) => n)).toEqual([])
  })

  it('preserves input order with a normal limit', async () => {
    const out = await mapBounded([10, 20, 30, 40], 2, async (n) => n + 1)
    expect(out).toEqual([11, 21, 31, 41])
  })
})
