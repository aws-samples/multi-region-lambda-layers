import { FlatCompat } from '@eslint/eslintrc';
import tseslint from 'typescript-eslint';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'cdk.out/**'],
  },
  ...compat.extends('airbnb-base', 'airbnb-typescript/base'),
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      '@typescript-eslint/comma-dangle': ['error', 'only-multiline'],
      'object-curly-newline': ['error', { ImportDeclaration: 'never' }],
      'no-new': 'off',
      'max-len': ['error', { code: 140 }],
    },
  },
);
