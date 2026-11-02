import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  { ignores: ['node_modules/**', 'out/**', 'dist/**', 'output/**', '.cache/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.{ts,tsx,mjs,cjs}'], plugins: { 'react-hooks': reactHooks }, languageOptions: { globals: {
    console: 'readonly', process: 'readonly', Buffer: 'readonly', URL: 'readonly',
    setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
    fetch: 'readonly', AbortSignal: 'readonly', require: 'readonly', module: 'readonly', __filename: 'readonly', __dirname: 'readonly'
  } }, rules: {
    'no-undef': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    '@typescript-eslint/no-require-imports': 'off',
    '@typescript-eslint/no-explicit-any': 'error',
    'react-hooks/rules-of-hooks': 'error',
    'no-debugger': 'error'
  } }
]
