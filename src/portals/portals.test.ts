import { describe, it, expect } from 'vitest'
import { FakeConfigProvider, loadConfig } from '../config/index.js'
import { PortalError, PortalRegistry } from './index.js'

const config = loadConfig(
  new FakeConfigProvider({
    portals: {
      PORTAL_A: { tokenEnv: 'TKN_A', expectedHubId: 111, label: 'Portal A', allowWrite: true },
      PORTAL_B: { tokenEnv: 'TKN_B', expectedHubId: 0, label: 'Portal B', allowWrite: false },
    },
  }),
)

const registry = () => new PortalRegistry(config)

describe('PortalRegistry', () => {
  it('lists configured keys', () => {
    expect(registry().keys()).toEqual(['PORTAL_A', 'PORTAL_B'])
  })

  it('get() resolves a known portal and throws PortalError on unknown', () => {
    const r = registry()
    expect(r.get('PORTAL_A').label).toBe('Portal A')
    expect(() => r.get('NOPE')).toThrow(PortalError)
  })

  it('list() returns non-secret summaries with no token material', () => {
    const serialized = JSON.stringify(registry().list())
    expect(JSON.parse(serialized).map((s: { key: string }) => s.key)).toEqual([
      'PORTAL_A',
      'PORTAL_B',
    ])
    expect(serialized).not.toContain('TKN_') // env-var names must not leak
    expect(serialized.toLowerCase()).not.toContain('token')
  })
})

describe('requiredPortalSchema (the explicit-portal gate)', () => {
  it('accepts a configured key', () => {
    expect(registry().requiredPortalSchema().parse('PORTAL_A')).toBe('PORTAL_A')
  })
  it('rejects an unknown key', () => {
    expect(() => registry().requiredPortalSchema().parse('NOPE')).toThrow()
  })
  it('rejects a missing portal (undefined)', () => {
    expect(() => registry().requiredPortalSchema().parse(undefined)).toThrow()
  })
})

describe('selected/default portal (READS only)', () => {
  it('setSelected + getSelected round-trips a known key', () => {
    const r = registry()
    r.setSelected('PORTAL_B')
    expect(r.getSelected()).toBe('PORTAL_B')
  })
  it('setSelected rejects an unknown key', () => {
    expect(() => registry().setSelected('NOPE')).toThrow(PortalError)
  })
  it('resolveForRead uses the explicit key over the selected default', () => {
    const r = registry()
    r.setSelected('PORTAL_A')
    expect(r.resolveForRead('PORTAL_B').key).toBe('PORTAL_B')
  })
  it('resolveForRead falls back to the selected default', () => {
    const r = registry()
    r.setSelected('PORTAL_A')
    expect(r.resolveForRead().key).toBe('PORTAL_A')
  })
  it('resolveForRead throws when no key and no default selected', () => {
    expect(() => registry().resolveForRead()).toThrow(PortalError)
  })
})
