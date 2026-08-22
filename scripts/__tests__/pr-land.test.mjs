import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { hardStopHits, ciCovers, needsRebase, loadConfig, DEFAULTS, EXIT } = require('../pr-land.js');

// These three predicates decide whether a PR may merge without a human, so they
// are asserted rather than smoke-tested: a false negative auto-merges a security
// rules change. They are pure and take an explicit config, so the shared script
// is testable without any repo's config on disk.

/** A representative consumer config — shape, not any one repo's values. */
const cfg = loadConfig('/nonexistent-so-defaults-apply');
Object.assign(cfg, {
  ciPaths: ['src/', 'functions/', 'package.json', 'pnpm-lock.yaml'],
  sharedBlastRadius: ['packages/shared/', 'pnpm-lock.yaml'],
  hardStop: [
    { pattern: /^firestore\.rules$/, why: 'security rules' },
    { pattern: /^scripts\/backfills\//, why: 'data backfill' },
  ],
});

test('defaults fail closed: no hard-stop rules, but review still required', () => {
  assert.deepEqual(DEFAULTS.hardStop, []);
  assert.equal(DEFAULTS.requireApprovingReview, true);
});

/** Writes a throwaway repo root carrying just `.agents/land.config.json`. */
function repoWithConfig(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'land-cfg-'));
  fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.agents/land.config.json'), JSON.stringify(config));
  return root;
}

test('mergeMethod defaults to a merge commit and is overridable', () => {
  assert.equal(DEFAULTS.mergeMethod, 'merge');
  assert.equal(loadConfig(repoWithConfig({ mergeMethod: 'squash' })).mergeMethod, 'squash');
});

test('an unusable mergeMethod is rejected at load, not at the merge', () => {
  // The merge is the one step where a config typo must not surface: by then the
  // push, the CI wait and the review have all already succeeded.
  assert.throws(() => loadConfig(repoWithConfig({ mergeMethod: 'sqush' })), /mergeMethod/);
});

test('loadConfig compiles pattern strings into regexes', () => {
  const c = loadConfig('/nonexistent');
  c.hardStop = [{ pattern: '^a/b$', why: 'x' }];
  const compiled = loadConfig('/nonexistent');
  assert.ok(compiled.hardStopTrailer instanceof RegExp);
  assert.equal(compiled.hardStopTrailer.test('Breaking-Client: yes'), true);
});

test('hard stop: configured paths never self-merge', () => {
  assert.equal(hardStopHits(['firestore.rules'], '', cfg).length, 1);
  assert.equal(hardStopHits(['scripts/backfills/0012-foo.js'], '', cfg).length, 1);
});

test('hard stop: a Breaking-Client trailer gates regardless of paths', () => {
  const msg = 'feat(api): drop legacy field\n\nBreaking-Client: removes the v1 shape\n';
  assert.equal(hardStopHits(['README.md'], msg, cfg).length, 1);
  assert.equal(hardStopHits(['README.md'], 'feat: harmless\n', cfg).length, 0);
});

test('hard stop: ordinary source and doc changes are not gated', () => {
  assert.deepEqual(hardStopHits(['src/screens/Home.tsx'], '', cfg), []);
  assert.deepEqual(hardStopHits(['docs/plans/ideas/whatever.md'], '', cfg), []);
});

test('vacuous green: docs-only diffs dispatch no CI run', () => {
  assert.equal(ciCovers(['docs/x.md', 'README.md'], cfg), false);
  assert.equal(ciCovers(['.maestro/flows/login.yaml'], cfg), false);
});

test('vacuous green: code diffs are covered by CI', () => {
  assert.equal(ciCovers(['src/services/foo.ts'], cfg), true);
  assert.equal(ciCovers(['docs/x.md', 'functions/index.ts'], cfg), true);
});

test('vacuous green: an unconfigured repo reports NO coverage, never silent green', () => {
  const bare = loadConfig('/nonexistent');
  assert.equal(ciCovers(['src/anything.ts'], bare), false);
});

test('staleness: a base move that misses this diff does not force a rebase', () => {
  assert.equal(needsRebase(['src/A.tsx'], ['functions/index.ts'], cfg).rebase, false);
});

test('staleness: direct file overlap forces a rebase', () => {
  const r = needsRebase(['functions/index.ts'], ['functions/index.ts'], cfg);
  assert.equal(r.rebase, true);
  assert.deepEqual(r.overlap, ['functions/index.ts']);
});

test('staleness: shared blast radius forces a rebase without file overlap', () => {
  const r = needsRebase(['pnpm-lock.yaml'], ['src/A.tsx'], cfg);
  assert.equal(r.rebase, true);
  assert.deepEqual(r.overlap, []);
  assert.deepEqual(r.blast, ['pnpm-lock.yaml']);
});

test('exit codes are stable — agents branch on these', () => {
  assert.deepEqual(EXIT, {
    MERGED: 0,
    CI_RED: 10,
    CHANGES_REQUESTED: 20,
    NEEDS_HUMAN: 30,
    PREFLIGHT: 40,
  });
});

test('ciPaths ["**"] means the repo has no path filter and CI always runs', () => {
  const all = loadConfig('/nonexistent');
  all.ciPaths = ['**'];
  assert.equal(ciCovers(['docs/anything.md'], all), true);
  assert.equal(ciCovers([], all), false, 'an empty diff still covers nothing');
});
