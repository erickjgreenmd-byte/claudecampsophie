// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.expo/**',
      '**/.wrangler/**',
      'reference/**',
      'templates/**',
      'finance/**',
      'brand/**',
      'apps/mobile/babel.config.js',
      'apps/mobile/metro.config.js',
      '**/*.config.js',
      '**/*.config.cjs',
      '**/vitest.config.ts',
      '**/vite.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Child-safety and correctness: never execute model- or user-supplied text.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Worker source must be type-checked with Workers types, not the tests' Node/DOM environment that
    // the project service would otherwise reuse for files the tests import.
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/api/src/**/*.test.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ['./apps/api/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
);
