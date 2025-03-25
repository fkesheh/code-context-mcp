export default {
  preset: 'ts-jest/presets/default-esm',
  clearMocks: true,
  coverageDirectory: "coverage",
  roots: [
    "./tests"
  ],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        isolatedModules: true,
        useESM: true,
        tsconfig: './tsconfig.json'
      }
    ]
  },
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node', 'mjs'],
  extensionsToTreatAsEsm: ['.ts', '.mts'],
  transformIgnorePatterns: [
    'node_modules/(?!(@huggingface)/)'
  ],
  testMatch: [
    '**/?(*.)+(spec|test).ts',
    '**/tests/*EmbeddingsTest.ts',
    '**/tests/githubRepoTest.ts'
  ],
  globals: {
    'ts-jest': {
      useESM: true,
    },
  },
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  verbose: true
};
