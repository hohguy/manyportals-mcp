export * from './types.js'
export * from './http.js'
// NOTE: FakeHubSpotClient (./fake.js) is deliberately NOT re-exported here — it is a
// test double and must not reach the production bundle. Tests import it directly via
// the fake module path; tsconfig.build.json excludes fake.ts. (R3.E/L5, bundle.test.ts)
