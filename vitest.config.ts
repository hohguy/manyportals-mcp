import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    /**
     * vitest's default is 5s, which was never a decision anyone made here. The suite
     * now spawns a lot of subprocesses (bash gates, node, `npm pack`, and a nested
     * vitest in the guard register's own tests), so CPU contention is high and the
     * CPU-bound scrypt cases in the vault tests were starving past 5s. Two unrelated
     * tests went red in one run for that reason, and neither failure said anything
     * about the code under test.
     *
     * 30s is generous enough to absorb contention and a slower CI runner, and still
     * short enough that a genuinely hung test fails rather than hangs the build.
     * Tests that shell out keep their own longer, explicit timeouts.
     */
    testTimeout: 30_000,
  },
})
