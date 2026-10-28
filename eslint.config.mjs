import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'vendor/**', 'models/**', 'artifacts/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-expressions': [
        'error',
        { allowShortCircuit: true, allowTernary: true },
      ],
      'func-style': ['error', 'expression'],
      'no-restricted-syntax': ['error', 'ClassDeclaration', 'ClassExpression'],
    },
  },
);
