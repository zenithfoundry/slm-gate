export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  // Redirects LEDGER_PATH to a temp DB before any module loads. Without this, suites that
  // call `DELETE FROM events` wipe the developer's real ledger. See tests/setup-env.ts.
  setupFiles: ['<rootDir>/tests/setup-env.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        diagnostics: {
          ignoreCodes: [1343, 151002]
        },
        tsconfig: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
          rootDir: '.'
        }
      },
    ],
  },
};
