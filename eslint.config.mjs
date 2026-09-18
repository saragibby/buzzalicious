import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';

/**
 * Flat config, ESLint 9.
 *
 * The prototype's `lint` scripts referenced ESLint but no config file existed, so both
 * workspaces' lint commands failed on every run. This is the first config the repo has
 * had; the rules below are the ones that encode decisions from `docs/`, not style
 * preferences. Formatting is Prettier's job and `eslint-config-prettier` turns off
 * everything that would overlap.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'backend/prisma/migrations/**',
      // Preserved prototype code, quoted verbatim so review can verify nothing was lost.
      // Linting it would invite edits, and an edited quotation is not a record.
      'docs/reference/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // `any` erases the type safety that is most of the point of this rewrite.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  // Backend application code.
  {
    files: ['backend/src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Structured logging only. `console` output on Heroku is unstructured, unfilterable
      // and unredactable — the prototype logged tokens and email addresses this way.
      'no-console': 'error',

      // Every thrown error should be an AppError subclass, so the error boundary can
      // decide what is safe to tell a client instead of guessing from a bare message.
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Error']",
          message:
            'Throw an AppError subclass from platform/errors.ts so the error handler can decide what is safe to expose.',
        },
      ],

      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Read configuration through platform/config.ts. Deriving values from process.env in more than one place is how the prototype ended up with three different base URLs.',
        },
      ],

      // The layering rule from docs/01-architecture.md, mechanically enforced.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/http/*', '**/http'],
              message:
                'modules/ and platform/ must not import http/. Business logic that needs a Request belongs in the transport layer, and code that imports Express cannot be tested without it.',
            },
          ],
        },
      ],
    },
  },

  // The bootstrap files and the config module are the exceptions, by design.
  {
    files: [
      'backend/src/platform/config.ts',
      'backend/src/platform/boot.ts',
      'backend/src/index.ts',
      'backend/src/worker.ts',
      'backend/eslint-exempt/**',
    ],
    rules: { 'no-restricted-properties': 'off' },
  },

  // http/ is allowed to import itself.
  {
    files: ['backend/src/http/**/*.ts', 'backend/src/index.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // Parked prototype code awaiting W6. It still has to lint; the env read is the one
  // thing it is explicitly excused for, and its header says why.
  {
    files: ['backend/src/modules/publish/x/twitter.service.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },

  // Frontend.
  {
    files: ['frontend/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // Tests may reach for the things application code may not.
  {
    files: ['**/*.test.{ts,tsx}', '**/tests/**/*.{ts,tsx}', '**/*.config.{ts,js}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-console': 'off',
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  prettier,
);
