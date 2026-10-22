const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const yaml = require('js-yaml');

const workflow = yaml.load(readFileSync(path.join(__dirname, '../workflows/release-please.yml'), 'utf8'));
const publishStep = workflow.jobs.publish.steps.find((step) => step.name === 'Publish packages to NPM');
const lernaRequire = createRequire(require.resolve('lerna'));
const provenancePath = path.join(path.dirname(lernaRequire.resolve('libnpmpublish')), 'provenance.js');

function fixture(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'release-provenance-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main');
  git(
    '-c',
    'user.name=Release Test',
    '-c',
    'user.email=release@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-m',
    'release'
  );
  const releaseSha = git('rev-parse', 'HEAD');
  git('tag', 'release');
  git(
    '-c',
    'user.name=Release Test',
    '-c',
    'user.email=release@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-m',
    'recovery workflow'
  );
  const workflowSha = git('rev-parse', 'HEAD');
  const bin = path.join(cwd, 'bin');
  mkdirSync(bin);
  // The workflow's real shell step runs, but npm is replaced so no publish or authentication can occur.
  writeFileSync(
    path.join(bin, 'npm'),
    `#!/usr/bin/env node\nconst { execFileSync } = require('node:child_process');\nconsole.log(JSON.stringify({ args: process.argv.slice(2), env: process.env, gitHead: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim() }));\nprocess.exit(Number(process.env.NPM_STUB_STATUS || 0));\n`,
    { mode: 0o755 }
  );
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GITHUB_ACTIONS: 'true',
    GITHUB_SHA: workflowSha,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_SHA: workflowSha,
    GITHUB_WORKFLOW_REF: 'grafana/faro-react-native-sdk/.github/workflows/release-please.yml@refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'grafana/faro-react-native-sdk',
    GITHUB_REPOSITORY_ID: '1',
    GITHUB_REPOSITORY_OWNER_ID: '2',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    RUNNER_ENVIRONMENT: 'github-hosted',
    RELEASE_REF: workflowSha,
  };
  return {
    git,
    env,
    releaseSha,
    workflowSha,
    run: () => spawnSync('bash', ['-c', publishStep.run], { cwd, env, encoding: 'utf8' }),
  };
}

async function provenance(env) {
  const module = { exports: {} };
  // Exercise the library actually used by Lerna; replace only CI detection and external signing.
  vm.runInNewContext(
    readFileSync(provenancePath, 'utf8'),
    {
      module,
      Buffer,
      process: { env },
      require(name) {
        if (name === 'ci-info') return { GITHUB_ACTIONS: true };
        if (name === 'sigstore') return { attest: async (payload) => JSON.parse(payload.toString()) };
        return require(name);
      },
    },
    { filename: provenancePath }
  );
  return module.exports.generateProvenance([{ name: 'pkg:npm/test@1.0.0', digest: { sha512: 'test' } }], {});
}

test('recovery uses one commit for checkout, gitHead and npm provenance after main advances', async (t) => {
  const setup = fixture(t);
  assert.notEqual(setup.releaseSha, setup.workflowSha);
  const result = setup.run();
  assert.equal(result.status, 0, result.stderr);
  const published = JSON.parse(result.stdout);
  assert.deepEqual(published.args, ['run', 'publish', '--', 'from-package', '--yes', '--no-private']);
  assert.equal(published.gitHead, setup.workflowSha);
  assert.equal(published.env.GITHUB_SHA, setup.workflowSha);
  assert.equal(published.env.GITHUB_REF, setup.env.GITHUB_REF);
  assert.equal(published.env.GITHUB_WORKFLOW_SHA, setup.workflowSha);
  const payload = await provenance(published.env);
  const definition = payload.predicate.buildDefinition;
  assert.equal(definition.resolvedDependencies[0].digest.gitCommit, published.gitHead);
  assert.equal(
    definition.resolvedDependencies[0].uri,
    'git+https://github.com/grafana/faro-react-native-sdk@refs/heads/main'
  );
  assert.equal(definition.externalParameters.workflow.ref, 'refs/heads/main');
  assert.equal(definition.externalParameters.workflow.path, '.github/workflows/release-please.yml');
  assert.equal(definition.internalParameters.github.event_name, 'workflow_dispatch');
});

test('normal push publishing retains its original provenance identity', (t) => {
  const setup = fixture(t);
  setup.env.GITHUB_EVENT_NAME = 'push';
  const result = setup.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).env.GITHUB_SHA, setup.workflowSha);
});

test('rejects the old release checkout even when the selected release ref matches HEAD', (t) => {
  const setup = fixture(t);
  setup.git('checkout', '--detach', setup.releaseSha);
  setup.env.RELEASE_REF = setup.releaseSha;
  const result = setup.run();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Refusing to publish/);
});

test('rejects a selected ref that differs from the workflow commit', (t) => {
  const setup = fixture(t);
  setup.env.RELEASE_REF = setup.releaseSha;
  const result = setup.run();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
});

test('does not publish without the verified source ref', (t) => {
  const setup = fixture(t);
  delete setup.env.RELEASE_REF;
  const result = setup.run();
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
});

test('propagates a publishing failure', (t) => {
  const setup = fixture(t);
  setup.env.NPM_STUB_STATUS = '7';
  assert.equal(setup.run().status, 7);
});

test('keeps trusted publishing and provenance behind the existing approval gate', () => {
  assert.equal(workflow.jobs.publish.environment, 'npm-publish');
  assert.equal(workflow.jobs.publish.permissions['id-token'], 'write');
  assert.equal(workflow.jobs.publish.env.NPM_CONFIG_PROVENANCE, true);
  assert.equal(publishStep.env.RELEASE_REF, '${{ needs.release-please.outputs.release_ref }}');
});
