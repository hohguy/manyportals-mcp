import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // `.claude/worktrees/**`: a temporary git worktree created for an isolated agent lives
  // there and carries its own tsconfig.json, which makes typescript-eslint refuse to parse
  // anything at all ("multiple candidate TSConfigRootDirs are present"). It is a transient
  // local artifact, never part of the project, and never shipped.
  { ignores: ['dist/**', 'build/**', 'coverage/**', 'node_modules/**', '.claude/worktrees/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Repo tooling that runs under node, outside the TypeScript build: it uses node
    // globals, which the recommended config does not declare on its own.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
  {
    rules: {
      // Surface unused vars as errors, but allow intentional `_`-prefixed args.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
)
