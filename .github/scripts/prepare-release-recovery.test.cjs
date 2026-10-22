const assert = require('node:assert/strict');
const { test } = require('node:test');

const { prepareReleaseRecovery } = require('./prepare-release-recovery.cjs');

const sha = '3a5e8b21fc893233c34981c44d7cd95a378e044b';
const mainSha = 'a'.repeat(40);
const manifest = { 'packages/react-native': '1.4.3', 'packages/react-native-tracing': '2.0.3' };

function fixture() {
  const outputs = {};
  const calls = [];
  const state = {
    comparison: 'ahead',
    manifest: { ...manifest },
    currentManifest: { ...manifest },
    packages: {
      'packages/react-native': { name: '@grafana/faro-react-native', version: '1.4.3' },
      'packages/react-native-tracing': { name: '@grafana/faro-react-native-tracing', version: '2.0.3' },
    },
    release: { draft: false, prerelease: false, published_at: '2026-10-22T15:00:14Z' },
    tagSha: sha,
  };
  const input = {
    sha,
    context: {
      eventName: 'workflow_dispatch',
      ref: 'refs/heads/main',
      repo: { owner: 'grafana', repo: 'faro-react-native-sdk' },
    },
    core: { info() {}, setOutput: (key, value) => (outputs[key] = value) },
    github: {
      rest: {
        repos: {
          async getCommit({ ref }) {
            calls.push(['commit', ref]);
            return { data: { sha: ref === 'main' ? mainSha : state.tagSha } };
          },
          async compareCommitsWithBasehead({ basehead }) {
            calls.push(['compare', basehead]);
            return { data: { status: state.comparison } };
          },
          async getContent({ path, ref }) {
            calls.push(['file', path, ref]);
            const json =
              path === 'release-please-manifest.json'
                ? ref === mainSha
                  ? state.currentManifest
                  : state.manifest
                : state.packages[path.replace('/package.json', '')];
            return {
              data: { type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(json)).toString('base64') },
            };
          },
          async getReleaseByTag({ tag }) {
            calls.push(['release', tag]);
            return { data: { tag_name: tag, ...state.release } };
          },
        },
      },
    },
  };
  return { input, state, calls, outputs };
}

test('checks both releases and pins subsequent jobs to the release commit', async () => {
  const { input, calls, outputs } = fixture();
  await prepareReleaseRecovery(input);
  assert.deepEqual(outputs, { release_ref: sha, releases_created: 'true' });
  assert.ok(calls.some((call) => call[0] === 'compare' && call[1] === `${sha}...${mainSha}`));
  assert.deepEqual(
    calls.filter(([kind]) => kind === 'release').map(([, tag]) => tag),
    ['faro-react-native-v1.4.3', 'faro-react-native-tracing-v2.0.3']
  );
  assert.ok(
    calls.filter(([kind, path]) => kind === 'file' && path.endsWith('/package.json')).every(([, , ref]) => ref === sha)
  );
});

test('accepts a release that is still the latest commit on main', async () => {
  const { input, state, outputs } = fixture();
  state.comparison = 'identical';
  input.github.rest.repos.getCommit = async () => ({ data: { sha } });
  await prepareReleaseRecovery(input);
  assert.deepEqual(outputs, { release_ref: sha, releases_created: 'true' });
});

const rejected = [
  [
    'a non-manual run',
    ({ input }) => {
      input.context.eventName = 'push';
    },
  ],
  [
    'a non-main workflow',
    ({ input }) => {
      input.context.ref = 'refs/heads/feature';
    },
  ],
  [
    'an abbreviated SHA',
    ({ input }) => {
      input.sha = sha.slice(0, 7);
    },
  ],
  [
    'a missing SHA',
    ({ input }) => {
      delete input.sha;
    },
  ],
  [
    'a branch name',
    ({ input }) => {
      input.sha = 'main';
    },
  ],
  [
    'a commit outside main',
    ({ state }) => {
      state.comparison = 'diverged';
    },
  ],
  [
    'a commit ahead of main',
    ({ state }) => {
      state.comparison = 'behind';
    },
  ],
  [
    'a newer release on main',
    ({ state }) => {
      state.currentManifest['packages/react-native'] = '1.4.4';
    },
  ],
  [
    'an unexpected package',
    ({ state }) => {
      state.manifest.extra = '1.0.0';
    },
  ],
  [
    'a prerelease version',
    ({ state }) => {
      state.manifest['packages/react-native'] = '1.4.3-beta.1';
      state.currentManifest = { ...state.manifest };
    },
  ],
  [
    'a missing version',
    ({ state }) => {
      state.manifest['packages/react-native'] = null;
      state.currentManifest = { ...state.manifest };
    },
  ],
  [
    'a package version mismatch',
    ({ state }) => {
      state.packages['packages/react-native'].version = '1.4.4';
    },
  ],
  [
    'a package name mismatch',
    ({ state }) => {
      state.packages['packages/react-native'].name = '@other/package';
    },
  ],
  [
    'a private package',
    ({ state }) => {
      state.packages['packages/react-native'].private = true;
    },
  ],
  [
    'a draft release',
    ({ state }) => {
      state.release.draft = true;
    },
  ],
  [
    'a prerelease',
    ({ state }) => {
      state.release.prerelease = true;
    },
  ],
  [
    'an unpublished release',
    ({ state }) => {
      state.release.published_at = null;
    },
  ],
  [
    'a moved tag',
    ({ state }) => {
      state.tagSha = mainSha;
    },
  ],
  [
    'a moved second tag',
    ({ input }) => {
      const getCommit = input.github.rest.repos.getCommit;
      input.github.rest.repos.getCommit = async (args) => {
        return args.ref.includes('tracing') ? { data: { sha: mainSha } } : getCommit(args);
      };
    },
  ],
  [
    'an unreadable manifest',
    ({ input }) => {
      input.github.rest.repos.getContent = async () => ({ data: { type: 'dir' } });
    },
  ],
  [
    'a missing second release',
    ({ input }) => {
      const getRelease = input.github.rest.repos.getReleaseByTag;
      input.github.rest.repos.getReleaseByTag = async (args) => {
        if (args.tag.includes('tracing')) throw new Error('Not Found');
        return getRelease(args);
      };
    },
  ],
  [
    'a GitHub API failure',
    ({ input }) => {
      input.github.rest.repos.getContent = async () => {
        throw new Error('GitHub unavailable');
      };
    },
  ],
];

for (const [name, change] of rejected) {
  test(`rejects ${name} without enabling publication`, async () => {
    const setup = fixture();
    change(setup);
    await assert.rejects(prepareReleaseRecovery(setup.input));
    assert.deepEqual(setup.outputs, {});
  });
}
