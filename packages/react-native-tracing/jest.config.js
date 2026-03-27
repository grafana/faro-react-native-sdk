const { jestBaseConfig } = require('../../jest.config.base.js');

module.exports = {
  ...jestBaseConfig,
  roots: ['packages/react-native-tracing/src'],
  // Avoid hanging CI after "Ran all test suites." when handles keep Node alive
  forceExit: true,
  testEnvironment: 'jsdom',
  setupFiles: ['<rootDir>/packages/react-native-tracing/setup.jest.ts'],
};
