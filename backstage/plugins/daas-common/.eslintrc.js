module.exports = require('@backstage/cli/config/eslint-factory')(__dirname, {
  rules: {
    // Hoisted helpers below the component that uses them read top-down; keep that style.
    '@typescript-eslint/no-use-before-define': ['error', { functions: false, classes: true, variables: true }],
    // Loading / error / empty / content branches in JSX are clearest as one conditional chain.
    'no-nested-ternary': 'off',
  },
  overrides: [
    {
      // Tests and the dev harness use the real JSON Schemas from spec/ at the repo root.
      files: ['src/testing/**', 'dev/**'],
      rules: { '@backstage/no-relative-monorepo-imports': 'off' },
    },
  ],
});
