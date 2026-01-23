const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const path = require('path');
const fs = require('fs');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = {
  watchFolders: [workspaceRoot],

  resolver: {
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],

    // Custom resolver to force React from correct location
    resolveRequest: (context, moduleName, platform) => {
      // Force React and React Native to resolve from where they actually are
      if (moduleName === 'react' || moduleName === 'react-native') {
        // Check demo's node_modules first
        const demoPath = path.join(
          projectRoot,
          'node_modules',
          moduleName,
          'index.js',
        );
        if (fs.existsSync(demoPath)) {
          return {
            filePath: demoPath,
            type: 'sourceFile',
          };
        }

        // Fall back to workspace root node_modules
        const rootPath = path.join(
          workspaceRoot,
          'node_modules',
          moduleName,
          'index.js',
        );
        if (fs.existsSync(rootPath)) {
          return {
            filePath: rootPath,
            type: 'sourceFile',
          };
        }
      }

      // Let Metro resolve everything else normally
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
