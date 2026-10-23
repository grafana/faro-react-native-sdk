const assert = require('node:assert/strict');

const packages = [
  { path: 'packages/react-native', name: '@grafana/faro-react-native', tag: 'faro-react-native-v' },
  {
    path: 'packages/react-native-tracing',
    name: '@grafana/faro-react-native-tracing',
    tag: 'faro-react-native-tracing-v',
  },
];

// Recovery may change its own tooling, but not the source or inputs used to build the release.
const recoveryFiles = new Set([
  '.github/scripts/prepare-release-recovery.cjs',
  '.github/scripts/prepare-release-recovery.test.cjs',
  '.github/scripts/publish-release.test.cjs',
  '.github/workflows/pull-request.yml',
  '.github/workflows/release-please.yml',
  'CONTRIBUTING.md',
]);

async function prepareReleaseRecovery({ github, context, core, sha }) {
  assert.equal(context.eventName, 'workflow_dispatch', 'Release recovery must be started manually');
  assert.equal(context.ref, 'refs/heads/main', 'Release recovery must run from main');
  assert.match(sha || '', /^[a-f0-9]{40}$/, 'Provide the full release commit SHA');
  assert.match(context.sha || '', /^[a-f0-9]{40}$/, 'Missing workflow commit SHA');

  const repo = context.repo;
  const { data: main } = await github.rest.repos.getCommit({ ...repo, ref: 'main' });
  const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
    ...repo,
    basehead: `${sha}...${context.sha}`,
  });
  assert.ok(['ahead', 'identical'].includes(comparison.status), 'Release commit must be an ancestor of this workflow');

  async function readTree(ref) {
    const { data } = await github.rest.git.getTree({ ...repo, tree_sha: ref, recursive: '1' });
    assert.equal(data.truncated, false, `Cannot verify the complete source tree at ${ref}`);
    return new Map(data.tree.filter((entry) => entry.type !== 'tree').map((entry) => [entry.path, entry]));
  }

  const releaseTree = await readTree(sha);
  const workflowTree = await readTree(context.sha);
  for (const path of new Set([...releaseTree.keys(), ...workflowTree.keys()])) {
    const released = releaseTree.get(path);
    const current = workflowTree.get(path);
    if (released?.sha === current?.sha && released?.mode === current?.mode && released?.type === current?.type)
      continue;
    assert.ok(recoveryFiles.has(path), `Release inputs changed at ${path}; prepare a new release instead`);
    assert.ok(
      current?.type === 'blob' && current.mode === '100644',
      `Recovery file must remain a regular file: ${path}`
    );
  }

  async function readJson(path, ref) {
    const { data } = await github.rest.repos.getContent({ ...repo, path, ref });
    assert.ok(data.type === 'file' && data.encoding === 'base64', `Cannot read ${path} at ${ref}`);
    return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  }

  const manifest = await readJson('release-please-manifest.json', sha);
  const currentManifest = await readJson('release-please-manifest.json', main.sha);
  assert.deepEqual(
    Object.keys(manifest).sort(),
    packages.map(({ path }) => path).sort(),
    'Unexpected release packages'
  );
  assert.deepEqual(currentManifest, manifest, 'A newer release exists on main; do not republish an older release');

  for (const pkg of packages) {
    const version = manifest[pkg.path];
    assert.match(version || '', /^\d+\.\d+\.\d+$/, 'Recovery only supports stable releases');
    const metadata = await readJson(`${pkg.path}/package.json`, sha);
    assert.equal(metadata.name, pkg.name, `Unexpected package at ${pkg.path}`);
    assert.equal(metadata.version, version, `Manifest version differs for ${pkg.name}`);
    assert.notEqual(metadata.private, true, `Cannot publish private package ${pkg.name}`);

    const tag = `${pkg.tag}${version}`;
    const { data: release } = await github.rest.repos.getReleaseByTag({ ...repo, tag });
    assert.equal(release.tag_name, tag, 'Release tag differs');
    assert.equal(release.draft, false, `${tag} is still a draft`);
    assert.equal(release.prerelease, false, `${tag} is a prerelease`);
    assert.ok(release.published_at, `${tag} has not been published on GitHub`);
    const { data: commit } = await github.rest.repos.getCommit({ ...repo, ref: tag });
    assert.equal(commit.sha, sha, `${tag} points to a different commit`);
    core.info(`Verified ${tag} at ${sha}`);
  }

  // npm provenance uses the workflow SHA, not checkout HEAD. Build that SHA after verifying release inputs match.
  core.info(`Recovering release ${sha} from workflow commit ${context.sha}; package and build inputs are unchanged`);
  core.setOutput('release_ref', context.sha);
  core.setOutput('releases_created', 'true');
}

module.exports = { prepareReleaseRecovery };
