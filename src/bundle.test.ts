import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Bundle hygiene (R3.E / lesson L5): the test double must not re-enter the
 * production import graph, or it ships in the npm artifact (which handles real
 * credentials). Production code reaches the HubSpot boundary via
 * '../hubspot/index.js' (which does NOT re-export fake.js); only *.test.ts files
 * may import the fake directly. These guards fail the build if that regresses.
 */
const SRC = join(process.cwd(), 'src')

/** The one thing this file is looking for. Named so it can be tested directly. */
const IMPORTS_FAKE = /from\s*['"][^'"]*\/fake\.js['"]/

function productionSourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .map((f) => f.split(/[\\/]/).join('/'))
    .filter((f) => f.endsWith('.ts') && !/\.test\.ts$/.test(f) && !/(?:^|\/)fake\.ts$/.test(f))
}

describe('bundle hygiene (R3.E)', () => {
  // Its twin in egress.test.ts got a positive control in #85 and this did not. Without
  // one, `toEqual([])` passes whether the detector works or returns nothing, and a
  // rename that emptied the file list would read as a clean bundle (#113 8d).
  it('the detector recognises the import it is looking for', () => {
    expect(IMPORTS_FAKE.test(`import { FakeHubSpotClient } from '../hubspot/fake.js'`)).toBe(true)
    expect(IMPORTS_FAKE.test(`import { x } from './fake.js'`)).toBe(true)
    expect(IMPORTS_FAKE.test(`import { createHubSpotClient } from '../hubspot/index.js'`)).toBe(
      false,
    )
  })

  it('has production files to examine at all', () => {
    // An empty list makes the next case pass vacuously, which is how a guard stops
    // guarding without anything going red.
    expect(productionSourceFiles().length).toBeGreaterThan(10)
  })

  it('no production source imports the test fake', () => {
    const offenders = productionSourceFiles().filter((f) =>
      IMPORTS_FAKE.test(readFileSync(join(SRC, f), 'utf8')),
    )
    expect(offenders).toEqual([])
  })

  it('the hubspot barrel does not re-export the fake', () => {
    const barrel = readFileSync(join(SRC, 'hubspot/index.ts'), 'utf8')
    expect(/export\s+\*\s+from\s*['"]\.\/fake\.js['"]/.test(barrel)).toBe(false)
  })
})

describe('the manifest declares the vault passphrase sensitive', () => {
  /**
   * BOUND TO A PUBLISHED SENTENCE (#227). SAFETY.md says "ManyPortals declares the field
   * sensitive", and that sentence used to sit INSIDE an `observed` segment about Claude
   * Desktop. It is a claim about this project's own manifest, so it was bound to nothing
   * while carrying a date and a re-check instruction measured for somebody else's user
   * interface. Whether a client honours the flag is the client's business and stays
   * `observed`; whether we SET it is ours and is tested here.
   */
  it('declares the vault passphrase field sensitive in the manifest', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'manifest.json'), 'utf8')) as {
      user_config?: Record<string, { sensitive?: boolean; type?: string }>
    }
    const field = manifest.user_config?.vault_key
    // Non-vacuity: a renamed or removed field must fail here rather than skip the check.
    expect(field, 'manifest.json has no user_config.vault_key').toBeDefined()
    expect(field?.sensitive).toBe(true)
  })
})

describe('bundle version', () => {
  it('manifest.json and package.json agree', () => {
    // Claude Desktop keys extension installs on the manifest version: bump one
    // without the other and the install silently does nothing, while the runtime
    // reports the package version. Nothing tied the two before (#98).
    const root = process.cwd()
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as {
      version: string
    }
    expect(manifest.version).toBe(pkg.version)
  })
})
