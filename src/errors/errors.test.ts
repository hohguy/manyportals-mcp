import { describe, it, expect } from 'vitest'
import { SafeError, publicErrorMessage } from './index.js'
import { WritePlanError } from '../plans/index.js'
import { HubSpotError } from '../hubspot/index.js'

describe('publicErrorMessage', () => {
  it('surfaces a branded SafeError message verbatim', () => {
    expect(publicErrorMessage(new SafeError('safe detail'))).toBe('safe detail')
  })

  it('surfaces messages from our typed errors (they extend SafeError)', () => {
    expect(publicErrorMessage(new WritePlanError('bad plan'))).toBe('bad plan')
    expect(publicErrorMessage(new HubSpotError('status 404', 404))).toBe('status 404')
    expect(new WritePlanError('x')).toBeInstanceOf(SafeError)
    expect(new HubSpotError('x')).toBeInstanceOf(SafeError)
  })

  it('genericizes an UNKNOWN error (raw message could carry a token/body/path)', () => {
    expect(publicErrorMessage(new Error('connect ECONNREFUSED pat-na1-SECRET'))).toBe(
      'an internal error occurred',
    )
    expect(
      publicErrorMessage(new SyntaxError('Unexpected token in JSON: {"token":"pat-..."}')),
    ).toBe('an internal error occurred')
    expect(publicErrorMessage('a thrown string')).toBe('an internal error occurred')
    expect(publicErrorMessage({ message: 'pat-leak' })).toBe('an internal error occurred')
  })
})
