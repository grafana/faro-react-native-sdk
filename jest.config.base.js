exports.jestBaseConfig = {
  verbose: true,
  moduleNameMapper: {
    // Map test-utils package to source
    '^@grafana/faro-test-utils$': '<rootDir>/packages/test-utils/src/index.ts',
    // Map old /src/ paths to published package paths
    '^@grafana/faro-core/src/testUtils$': '@grafana/faro-core/testUtils',
    '^@grafana/faro-core/src/(.*)$': '@grafana/faro-core/$1',
    '^@grafana/faro-core/testUtils$': '@grafana/faro-core/testUtils',
  },
  rootDir: '../../',
  testEnvironment: 'jsdom',
  transform: {
    '^.+\\.ts?$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.spec.json',
      },
    ],
  },
};
