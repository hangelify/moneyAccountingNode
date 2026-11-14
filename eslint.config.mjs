// @ts-check
import eslint from '@eslint/js';
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import { defineConfig } from 'eslint/config';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';

// Old violations are frozen in eslint-suppressions.json: new code must pass every rule.
// After fixing frozen violations run `npm run lint:prune`.
export default defineConfig(
  {
    ignores: ['eslint.config.mjs', 'dist/**', 'coverage/**'],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  eslintComments.recommended,
  sonarjs.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/explicit-function-return-type': 'error',
      // Nest modules are empty classes carrying @Module() metadata.
      '@typescript-eslint/no-extraneous-class': [
        'error',
        { allowWithDecorator: true },
      ],
      // Tests reach private members via obj['name'] on purpose.
      '@typescript-eslint/dot-notation': [
        'error',
        {
          allowPrivateClassPropertyAccess: true,
          allowProtectedClassPropertyAccess: true,
        },
      ],
      // Same convention as tsconfig noUnusedParameters: a leading _ marks it intentional.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-console': 'error',
      'no-warning-comments': ['error', { terms: ['todo', 'fixme'] }],
      '@eslint-community/eslint-comments/require-description': 'error',
      '@eslint-community/eslint-comments/no-unused-disable': 'error',
      // A file-level /* eslint-disable rule -- reason */ at the top needs no matching enable.
      '@eslint-community/eslint-comments/disable-enable-pair': [
        'error',
        { allowWholeFile: true },
      ],
    },
  },
  {
    // Size and complexity limits: split the function or file instead of raising them.
    rules: {
      'sonarjs/cognitive-complexity': ['error', 15],
      'max-lines': [
        'error',
        { max: 300, skipBlankLines: true, skipComments: true },
      ],
      'max-lines-per-function': [
        'error',
        { max: 60, skipBlankLines: true, skipComments: true },
      ],
      'max-params': ['error', 4],
      'max-depth': ['error', 3],
      'no-nested-ternary': 'error',
      // Duplicates of checks that already run: tsc noUnusedLocals (and this
      // rule misses use inside decorators such as @Body()), no-nested-ternary,
      // @typescript-eslint/no-deprecated.
      'sonarjs/unused-import': 'off',
      'sonarjs/no-nested-conditional': 'off',
      'sonarjs/deprecation': 'off',
    },
  },
  {
    files: [
      '**/*.spec.ts',
      '**/*.int-spec.ts',
      '**/*.e2e-spec.ts',
      'test/**/*.ts',
    ],
    rules: {
      // describe/it/beforeEach callbacks need no annotated return type.
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      // supertest's .expect(200) is an assertion sonarjs does not see.
      'sonarjs/assertions-in-tests': 'off',
      // Fixtures: fake IPs and http:// URLs, random ids, sorting strings to
      // compare sets, exact numbers, spawning the CLI.
      'sonarjs/no-hardcoded-ip': 'off',
      'sonarjs/no-clear-text-protocols': 'off',
      'sonarjs/pseudo-random': 'off',
      'sonarjs/no-alphabetical-sort': 'off',
      'sonarjs/no-floating-point-equality': 'off',
      'sonarjs/no-os-command-from-path': 'off',
      // Long describe blocks and fixtures are normal in tests.
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      // expect(mock.method).toHaveBeenCalled() is the normal jest idiom.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    // CLI scripts for CI and developers: they report on the console and run
    // tools (git, squawk) from PATH, which CI and npm scripts control.
    files: ['scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
      'sonarjs/no-os-command-from-path': 'off',
    },
  },
  {
    // Class names are generated by mikro-orm migration:create.
    files: ['src/migrations/**/*.ts'],
    rules: {
      'sonarjs/class-name': 'off',
    },
  },
  eslintPluginPrettierRecommended,
  {
    rules: {
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
);
