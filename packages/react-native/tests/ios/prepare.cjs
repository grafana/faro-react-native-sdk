const { createHash } = require('node:crypto');
const { mkdirSync, readdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Compile the actual native source into a standalone XCTest bundle, without React Native or CocoaPods.
const here = __dirname;
if (process.argv.length !== 3) throw new Error('Usage: node prepare.cjs EMPTY_OUTPUT_DIRECTORY');
const output = path.resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
if (readdirSync(output).length) throw new Error('Choose an empty output directory');
const project = path.join(output, 'FrameVitals.xcodeproj');
mkdirSync(path.join(project, 'xcshareddata/xcschemes'), { recursive: true });
const objects = {};
const id = (name) => createHash('sha256').update(name).digest('hex').slice(0, 24).toUpperCase();
const add = (name, value) => ((objects[id(name)] = value), id(name));
const files = [
  path.resolve(here, '../../ios/RefreshRateVitals.swift'),
  path.join(here, 'RefreshRateVitalsTests.swift'),
];
const refs = files.map((file) =>
  add(file, { isa: 'PBXFileReference', lastKnownFileType: 'sourcecode.swift', path: file, sourceTree: '<absolute>' })
);
const configurations = (name, settings) =>
  add(`${name}-configs`, {
    isa: 'XCConfigurationList',
    buildConfigurations: ['Debug', 'Release'].map((configuration) =>
      add(`${name}-${configuration}`, {
        isa: 'XCBuildConfiguration',
        name: configuration,
        buildSettings: { ...settings, SWIFT_OPTIMIZATION_LEVEL: configuration === 'Release' ? '-O' : '-Onone' },
      })
    ),
    defaultConfigurationIsVisible: 0,
    defaultConfigurationName: 'Release',
  });
const product = add('product', {
  isa: 'PBXFileReference',
  explicitFileType: 'wrapper.cfbundle',
  path: 'FrameVitalsTests.xctest',
  sourceTree: 'BUILT_PRODUCTS_DIR',
});
const target = add('target', {
  isa: 'PBXNativeTarget',
  name: 'FrameVitalsTests',
  productName: 'FrameVitalsTests',
  productReference: product,
  productType: 'com.apple.product-type.bundle.unit-test',
  buildConfigurationList: configurations('target', {
    PRODUCT_NAME: '$(TARGET_NAME)',
    PRODUCT_BUNDLE_IDENTIFIER: 'com.grafana.framevitals.tests',
    SDKROOT: 'iphoneos',
    IPHONEOS_DEPLOYMENT_TARGET: '17.0',
    TARGETED_DEVICE_FAMILY: '1,2',
    SWIFT_VERSION: '5.0',
    GENERATE_INFOPLIST_FILE: 'YES',
    CODE_SIGNING_ALLOWED: 'NO',
  }),
  buildPhases: [
    add('sources', {
      isa: 'PBXSourcesBuildPhase',
      buildActionMask: 2147483647,
      files: refs.map((ref, index) => add(`build-${index}`, { isa: 'PBXBuildFile', fileRef: ref })),
      runOnlyForDeploymentPostprocessing: 0,
    }),
  ],
  buildRules: [],
  dependencies: [],
});
add('project', {
  isa: 'PBXProject',
  attributes: {},
  buildConfigurationList: configurations('project', { CLANG_ENABLE_MODULES: 'YES' }),
  compatibilityVersion: 'Xcode 14.0',
  developmentRegion: 'en',
  knownRegions: ['en', 'Base'],
  mainGroup: add('root', { isa: 'PBXGroup', children: [...refs, product], sourceTree: '<group>' }),
  projectDirPath: '',
  projectRoot: '',
  targets: [target],
});
const pbxproj = path.join(project, 'project.pbxproj');
writeFileSync(
  pbxproj,
  JSON.stringify({ archiveVersion: '1', classes: {}, objectVersion: '56', objects, rootObject: id('project') })
);
execFileSync('/usr/bin/plutil', ['-convert', 'xml1', pbxproj]);
const ref = `<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${target}" BuildableName="FrameVitalsTests.xctest" BlueprintName="FrameVitalsTests" ReferencedContainer="container:FrameVitals.xcodeproj"/>`;
writeFileSync(
  path.join(project, 'xcshareddata/xcschemes/FrameVitals.xcscheme'),
  `<?xml version="1.0" encoding="UTF-8"?>
<Scheme version="1.3">
  <BuildAction><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="NO" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="YES">${ref}</BuildActionEntry></BuildActionEntries></BuildAction>
  <TestAction buildConfiguration="Release" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB"><Testables><TestableReference skipped="NO">${ref}</TestableReference></Testables></TestAction>
</Scheme>`
);
process.stdout.write(`${project}\n`);
