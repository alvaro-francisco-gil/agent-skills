import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  hardStopHits, ciCovers, baseMovement, loadConfig, DEFAULTS, EXIT, CONFIG,
  reviewFor, CARRIED_REVIEW_MARKER, integrationVerdictPath, readIntegrationVerdictFile, judgeIntegrationVerdict,
  runIntegrationCheck,
} = require('../pr-land.js');
import { execSync } from 'node:child_process';

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
  const m = baseMovement(['src/A.tsx'], ['functions/index.ts'], cfg);
  assert.equal(m.needsRebase, false);
  assert.equal(m.needsIntegrationCheck, false);
});

test('staleness: direct file overlap forces a rebase', () => {
  const m = baseMovement(['functions/index.ts'], ['functions/index.ts'], cfg);
  assert.equal(m.needsRebase, true);
  assert.deepEqual(m.overlap, ['functions/index.ts']);
});

test('staleness: without an integrationCheck, a blast-radius move still rebases', () => {
  const m = baseMovement(['pnpm-lock.yaml'], ['src/A.tsx'], cfg);
  assert.equal(m.needsRebase, true);
  assert.equal(m.needsIntegrationCheck, false);
  assert.deepEqual(m.blast, ['pnpm-lock.yaml']);
});

test('staleness: with an integrationCheck, a blast-only move is checked locally instead', () => {
  const withCheck = { ...cfg, integrationCheck: { command: 'true', timeoutMs: 1000 } };
  const m = baseMovement(['packages/shared/src/x.ts'], ['src/A.tsx'], withCheck);
  assert.equal(m.needsRebase, false);
  assert.equal(m.needsIntegrationCheck, true);
});

test('staleness: overlap wins over the local check — the same file on both sides rebases', () => {
  const withCheck = { ...cfg, integrationCheck: { command: 'true', timeoutMs: 1000 } };
  const m = baseMovement(['packages/shared/src/x.ts'], ['packages/shared/src/x.ts'], withCheck);
  assert.equal(m.needsRebase, true);
  assert.equal(m.needsIntegrationCheck, false);
});

test('staleness: a rebaseRadius move rebases even when a local check is configured', () => {
  const withCheck = {
    ...cfg,
    sharedBlastRadius: ['packages/shared/', 'firestore.rules'],
    rebaseRadius: ['firestore.rules'],
    integrationCheck: { command: 'true', timeoutMs: 1000 },
  };
  const rules = baseMovement(['firestore.rules', 'packages/shared/x.ts'], ['src/A.tsx'], withCheck);
  assert.equal(rules.needsRebase, true, 'a typecheck cannot judge a rules change');
  assert.equal(rules.needsIntegrationCheck, false);
  assert.deepEqual(rules.forced, ['firestore.rules']);
  assert.deepEqual(rules.blast, ['packages/shared/x.ts'], 'a forced path is not double-counted');

  const shared = baseMovement(['packages/shared/x.ts'], ['src/A.tsx'], withCheck);
  assert.equal(shared.needsIntegrationCheck, true);
});

// The direction a base-only rule cannot see: the PR edits the shared code, the
// base edits its consumer. The PR's CI tested the new shared code against the OLD
// consumer, so the merged pair is exactly as unverified as the mirror case.
test('staleness is symmetric: a PR changing shared code is checked when the base moved a consumer', () => {
  const withCheck = { ...cfg, sharedBlastRadius: ['packages/shared/'], integrationCheck: { command: 'true', timeoutMs: 1000 } };
  const m = baseMovement(['functions/index.ts'], ['packages/shared/x.ts'], withCheck);
  assert.equal(m.needsIntegrationCheck, true);
  assert.deepEqual(m.blast, ['packages/shared/x.ts']);
});

test('staleness is symmetric for rebaseRadius too', () => {
  const withRadius = { ...cfg, rebaseRadius: ['pnpm-lock.yaml'] };
  const m = baseMovement(['src/A.tsx'], ['pnpm-lock.yaml'], withRadius);
  assert.equal(m.needsRebase, true, 'a dependency change was tested against the old code');
});

// The livelock this rule exists to prevent. A PR that edits package.json used to
// rebase on EVERY base move — the trigger was its own diff, which no rebase
// removes — and on a base that moves faster than CI, it never landed.
test('LIVELOCK: a PR changing a rebaseRadius path never rebases for it — it is checked wide', () => {
  const withCheck = {
    ...cfg,
    sharedBlastRadius: ['packages/shared/'],
    rebaseRadius: ['package.json'],
    integrationCheck: { command: 'true', timeoutMs: 1000 },
  };
  const m = baseMovement(['src/A.tsx'], ['package.json', 'functions/index.ts'], withCheck);
  assert.equal(m.needsRebase, false, 'the trigger is the PR itself; a rebase cannot remove it');
  assert.equal(m.needsIntegrationCheck, true);
  assert.equal(m.scope, 'wide');
});

test('the BASE moving a rebaseRadius path still rebases — and after it, the trigger is gone', () => {
  const withCheck = { ...cfg, rebaseRadius: ['package.json'], integrationCheck: { command: 'true', timeoutMs: 1000 } };
  assert.equal(baseMovement(['package.json'], ['src/A.tsx'], withCheck).needsRebase, true);
  assert.equal(baseMovement([], ['src/A.tsx'], withCheck).needsRebase, false, 'post-rebase: nothing moved');
});

test('a shared-only move is checked at scope "shared"', () => {
  const withCheck = { ...cfg, sharedBlastRadius: ['packages/shared/'], integrationCheck: { command: 'true', timeoutMs: 1000 } };
  assert.equal(baseMovement(['packages/shared/x.ts'], ['src/A.tsx'], withCheck).scope, 'shared');
});

test('staleness: the other side must have moved code — a docs-only base integrates nothing', () => {
  const withCheck = { ...cfg, sharedBlastRadius: ['packages/shared/'], rebaseRadius: ['pnpm-lock.yaml'], integrationCheck: { command: 'true', timeoutMs: 1000 } };
  const m = baseMovement(['docs/x.md'], ['packages/shared/x.ts', 'pnpm-lock.yaml'], withCheck);
  assert.equal(m.needsRebase, false);
  assert.equal(m.needsIntegrationCheck, false);
});

test('staleness: with no ciPaths declared, any change on the other side counts', () => {
  const bare = { ...loadConfig('/nonexistent'), sharedBlastRadius: ['packages/shared/'], integrationCheck: { command: 'true', timeoutMs: 1000 } };
  assert.equal(baseMovement(['docs/x.md'], ['packages/shared/x.ts'], bare).needsIntegrationCheck, true);
});

test('integrationCheck defaults off, and a malformed one is rejected at load', () => {
  assert.equal(DEFAULTS.integrationCheck, null);
  assert.throws(() => loadConfig(repoWithConfig({ integrationCheck: 'pnpm tsc' })), /integrationCheck/);
  assert.throws(() => loadConfig(repoWithConfig({ integrationCheck: { command: ' ' } })), /integrationCheck/);
  const c = loadConfig(repoWithConfig({ integrationCheck: { command: 'pnpm tsc' } }));
  assert.equal(c.integrationCheck.command, 'pnpm tsc');
  assert.ok(c.integrationCheck.timeoutMs > 0, 'a timeout is always set');
});

// --- review rounds ------------------------------------------------------------

test('a carried approval binds to its head but is not a round', () => {
  const reviews = [
    { state: 'CHANGES_REQUESTED', body: 'fix x', commit: { oid: 'a' } },
    { state: 'APPROVED', body: 'lgtm', commit: { oid: 'b' } },
    { state: 'APPROVED', body: `${CARRIED_REVIEW_MARKER}\nsame diff as b`, commit: { oid: 'c' } },
  ];
  const r = reviewFor(reviews, 'c');
  assert.equal(r.state, 'approved');
  assert.equal(r.rounds, 2);
});

// --- the integration check's recorded verdict ---------------------------------

// --- the integration check's recorded verdict ---------------------------------

const vcfg = { ...cfg, sharedBlastRadius: ['packages/shared/'], rebaseRadius: ['package.json'] };
const judge = (v, over = {}) =>
  judgeIntegrationVerdict(v, { baseTip: 't2', scope: 'shared', movedSince: [], prFiles: ['src/A.tsx'], ...over }, vcfg);

test('verdict: none recorded, or unreadable, is pending', () => {
  assert.equal(judge(null).state, 'pending');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-verdict-'));
  const file = integrationVerdictPath(dir, 'head1');
  assert.equal(readIntegrationVerdictFile(file), null);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"ok": tr');
  assert.equal(readIntegrationVerdictFile(file), null, 'a torn write is not a verdict');
});

test('verdict: on the same tip it stands, pass or fail', () => {
  assert.equal(judge({ baseTip: 't2', scope: 'shared', ok: true }).state, 'pass');
  const f = judge({ baseTip: 't2', scope: 'shared', ok: false, output: 'TS2339' });
  assert.deepEqual([f.state, f.output], ['fail', 'TS2339']);
});

// The starvation this exists to prevent: the check takes minutes, the base moves
// every few, and a verdict keyed by the exact tip would be re-run forever.
test('verdict: a PASS survives base moves that cannot matter to it', () => {
  const v = { baseTip: 't1', scope: 'shared', ok: true };
  assert.equal(judge(v, { movedSince: ['docs/x.md', 'apps/other/B.tsx'] }).state, 'pass');
});

test('verdict: a PASS is re-checked when the base moved the PR files or a radius', () => {
  const v = { baseTip: 't1', scope: 'shared', ok: true };
  assert.equal(judge(v, { movedSince: ['src/A.tsx'] }).state, 'pending', "the PR's own file");
  assert.equal(judge(v, { movedSince: ['packages/shared/x.ts'] }).state, 'pending', 'shared radius');
  assert.equal(judge(v, { movedSince: ['package.json'] }).state, 'pending', 'rebase radius');
  assert.equal(judge(v, { movedSince: null }).state, 'pending', 'an unreadable move is no answer');
});

test('verdict: an old FAIL is re-checked on a new tip — the base may have fixed it', () => {
  assert.equal(judge({ baseTip: 't1', scope: 'shared', ok: false }, { movedSince: ['docs/x.md'] }).state, 'pending');
});

test('verdict: a shared-scope PASS never answers a wide question', () => {
  assert.equal(judge({ baseTip: 't2', scope: 'shared', ok: true }, { scope: 'wide' }).state, 'pending');
  assert.equal(judge({ baseTip: 't2', scope: 'wide', ok: true }, { scope: 'shared' }).state, 'pass');
});

/**
 * A real repo: base adds `lib.js` exporting `answer`; the branch adds a caller.
 * The base then renames the export — no file overlap, a clean textual merge, and
 * a broken result. That is exactly the move a blast-radius rebase used to buy a
 * whole CI run to find.
 */
function repoWithSemanticBreak() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'land-int-'));
  const git = (cmd) => execSync(`git -c user.name=t -c user.email=t@t ${cmd}`, { cwd: root, stdio: 'pipe' }).toString().trim();
  git('init -q -b develop');
  fs.writeFileSync(path.join(root, 'lib.js'), 'exports.answer = 42;\n');
  git('add . && git -c user.name=t -c user.email=t@t commit -qm base');
  git('checkout -qb feat');
  fs.writeFileSync(path.join(root, 'use.js'), "if (require('./lib.js').answer !== 42) process.exit(1);\n");
  git('add . && git -c user.name=t -c user.email=t@t commit -qm feat');
  const head = git('rev-parse HEAD');
  git('checkout -q develop');
  const cleanTip = git('rev-parse HEAD');
  fs.writeFileSync(path.join(root, 'lib.js'), 'exports.theAnswer = 42;\n');
  git('add . && git -c user.name=t -c user.email=t@t commit -qm rename');
  const brokenTip = git('rev-parse HEAD');
  git('checkout -q feat');
  return { root, head, cleanTip, brokenTip };
}

test('the integration check judges the MERGE RESULT, and leaves the branch alone', () => {
  const { root, head, cleanTip, brokenTip } = repoWithSemanticBreak();
  const cwd = process.cwd();
  const saved = CONFIG.integrationCheck;
  // The scope reaches the command, so a repo can widen what it runs.
  CONFIG.integrationCheck = { command: 'test "$PR_LAND_INTEGRATION_SCOPE" = shared && node use.js', timeoutMs: 30_000 };
  try {
    process.chdir(root);
    const s = (baseTip) => ({ branch: { headSha: head }, baseTip, base: { scope: 'shared' } });
    assert.equal(runIntegrationCheck(s(cleanTip)), true);
    assert.equal(runIntegrationCheck(s(brokenTip)), false, 'the rename breaks the caller only once merged');

    const common = path.join(root, '.git');
    const v = readIntegrationVerdictFile(integrationVerdictPath(common, head));
    assert.deepEqual([v.ok, v.baseTip, v.scope], [false, brokenTip, 'shared'], 'the last run is recorded with what it judged');

    // The failing step must be what the tail shows, even when an earlier step
    // wrote its (passing) report to stderr — Jest does.
    CONFIG.integrationCheck = {
      command: 'echo "suite passed" >&2; echo "the real failure"; exit 1',
      timeoutMs: 30_000,
    };
    assert.equal(runIntegrationCheck(s(cleanTip)), false);
    const tail = readIntegrationVerdictFile(integrationVerdictPath(common, head)).output.trim().split('\n');
    assert.equal(tail.at(-1), 'the real failure');
    assert.equal(execSync('git rev-parse HEAD', { cwd: root }).toString().trim(), head, 'the branch did not move');
    assert.equal(execSync('git status --porcelain', { cwd: root }).toString(), '', 'the checkout is untouched');
    assert.equal(execSync('git worktree list', { cwd: root }).toString().trim().split('\n').length, 1, 'the scratch worktree is reaped');
  } finally {
    process.chdir(cwd);
    CONFIG.integrationCheck = saved;
  }
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

// ---------------------------------------------------------------------------
// The skip discriminator.
//
// Fixtures are the real `gh pr checks --json name,state,link` payloads from
// ordago-app/ordago-apps#777 at head 898853d, recorded 2026-08-28. That PR is
// the useful one because it carries BOTH kinds of skip on one head SHA:
//
//   · "Emulators · Vitest (functions) + E2E (shared)" and "request-review" —
//     `needs: [changes, lint-and-unit]` in develop-tests.yml, skipped because
//     lint-and-unit FAILED. These lanes never ran and must block.
//   · "Build image + deploy to Cloud Run" — `if: github.event_name == 'push'`
//     in web-build.yml, skipped by design on every PR. Must NOT block, or every
//     PR in every consuming repo wedges.
//
// Both are `conclusion: skipped` with a null runner and no steps. The run each
// sits in is what separates them.
// ---------------------------------------------------------------------------

const { checksVerdict, runIdOf } = require('../pr-land.js');

const CI_RUN = 'https://github.com/ordago-app/ordago-apps/actions/runs/33126802372/job/';
const WEB_RUN = 'https://github.com/ordago-app/ordago-apps/actions/runs/33126802218/job/';

/** ordago-apps#777 @ 898853d — the mixed-skip fixture. */
const pr777 = [
  { name: 'Container build (build stage only)', state: 'SUCCESS', link: WEB_RUN + '98713102462' },
  { name: 'Build image + deploy to Cloud Run', state: 'SKIPPED', link: WEB_RUN + '98713103662' },
  { name: 'Emulators · Vitest (functions) + E2E (shared)', state: 'SKIPPED', link: CI_RUN + '98711028084' },
  { name: 'request-review', state: 'SKIPPED', link: CI_RUN + '98711028301' },
  { name: 'Lint + Unit (app · shared · functions)', state: 'FAILURE', link: CI_RUN + '98706784606' },
  { name: 'Next.js lint + build', state: 'SUCCESS', link: WEB_RUN + '98706784156' },
  { name: 'Detect affected areas', state: 'SUCCESS', link: CI_RUN + '98706784727' },
];

const named = (v) => v.failures.map((c) => c.name).sort();

test('runIdOf reads the run out of a check link', () => {
  assert.equal(runIdOf(CI_RUN + '98711028084'), '33126802372');
  assert.equal(runIdOf(''), null);
  assert.equal(runIdOf(undefined), null);
});

test('a dependency-cascade skip blocks; a path-filtered skip in a clean run does not', () => {
  const v = checksVerdict(pr777, { ciWillRun: true }, cfg);
  assert.equal(v.state, 'red');
  assert.deepEqual(named(v), [
    'Emulators · Vitest (functions) + E2E (shared)',
    'Lint + Unit (app · shared · functions)',
    'request-review',
  ]);
  // The legitimate skip sits in a run with no failed sibling and stays silent.
  assert.ok(!named(v).includes('Build image + deploy to Cloud Run'));
});

test('a blocking skip says why, so the log does not read as a mystery', () => {
  const v = checksVerdict(pr777, { ciWillRun: true }, cfg);
  const em = v.failures.find((c) => c.name.startsWith('Emulators'));
  assert.match(em.why, /failed or was cancelled/);
  // A genuine failure is reported as itself, not dressed up as a skip.
  assert.equal(v.failures.find((c) => c.name.startsWith('Lint')).why, undefined);
});

test('the incident: a skipped required suite alone is red, not green', () => {
  // The counterfactual that made #772 dangerous — the starved upstream had it
  // been re-run green is removed here, leaving only the cancelled cause. Before
  // this guard the gate saw one SUCCESS and called the PR mergeable.
  const v = checksVerdict([
    { name: 'Lint + Unit (app · shared · functions)', state: 'CANCELLED', link: CI_RUN + '1' },
    { name: 'Emulators · Vitest (functions) + E2E (shared)', state: 'SKIPPED', link: CI_RUN + '2' },
    { name: 'Detect affected areas', state: 'SUCCESS', link: CI_RUN + '3' },
  ], { ciWillRun: true }, cfg);
  assert.equal(v.state, 'red');
  assert.deepEqual(named(v), ['Emulators · Vitest (functions) + E2E (shared)']);
});

test('an all-green run with only by-design skips is still green', () => {
  const v = checksVerdict([
    { name: 'Next.js lint + build', state: 'SUCCESS', link: WEB_RUN + '1' },
    { name: 'Build image + deploy to Cloud Run', state: 'SKIPPED', link: WEB_RUN + '2' },
    { name: 'Lint + Unit (app · shared · functions)', state: 'SUCCESS', link: CI_RUN + '1' },
  ], { ciWillRun: true }, cfg);
  assert.equal(v.state, 'green');
  assert.deepEqual(v.failures, []);
});

test('a skip is judged by its own run, not by any red anywhere on the PR', () => {
  // Cross-run contamination would be the wedge: `needs:` cannot span workflows,
  // so a failure in the CI run says nothing about a skip in the Web run.
  const v = checksVerdict([
    { name: 'Lint + Unit (app · shared · functions)', state: 'FAILURE', link: CI_RUN + '1' },
    { name: 'Build image + deploy to Cloud Run', state: 'SKIPPED', link: WEB_RUN + '2' },
    { name: 'Next.js lint + build', state: 'SUCCESS', link: WEB_RUN + '1' },
  ], { ciWillRun: true }, cfg);
  assert.deepEqual(named(v), ['Lint + Unit (app · shared · functions)']);
});

test('pending is still pending when the only skips are legitimate', () => {
  const v = checksVerdict([
    { name: 'Emulators · Vitest (functions) + E2E (shared)', state: 'QUEUED', link: CI_RUN + '1' },
    { name: 'Build image + deploy to Cloud Run', state: 'SKIPPED', link: WEB_RUN + '2' },
  ], { ciWillRun: true }, cfg);
  assert.equal(v.state, 'pending');
});

test('a diff that dispatched nothing is `none`, not red', () => {
  // A docs-only PR: every check skipped, no cause anywhere. This must stay the
  // UNVERIFIED path gated on review, not become an unmergeable PR.
  const v = checksVerdict([
    { name: 'Build image + deploy to Cloud Run', state: 'SKIPPED', link: WEB_RUN + '2' },
    { name: 'Emulators · Vitest (functions) + E2E (shared)', state: 'SKIPPED', link: CI_RUN + '2' },
  ], { ciWillRun: false }, cfg);
  assert.equal(v.state, 'none');
  assert.deepEqual(v.failures, []);
});

test('NEUTRAL is still ignored, and an empty list is still `none`', () => {
  assert.equal(checksVerdict([], {}, cfg).state, 'none');
  assert.equal(
    checksVerdict([{ name: 'advisory', state: 'NEUTRAL', link: CI_RUN + '1' }], {}, cfg).state,
    'none',
  );
});

test('requiredLanes is opt-in: unconfigured repos keep exactly today’s behaviour', () => {
  const stale = [
    // The residual case the run-level signal cannot see: the failed upstream was
    // re-run green, leaving its dependent skipped from the earlier attempt. The
    // run now looks clean, so only a named lane catches it.
    { name: 'Lint + Unit (app · shared · functions)', state: 'SUCCESS', link: CI_RUN + '1' },
    { name: 'Emulators · Vitest (functions) + E2E (shared)', state: 'SKIPPED', link: CI_RUN + '2' },
  ];
  assert.equal(checksVerdict(stale, { ciWillRun: true }, cfg).state, 'green');

  const guarded = { ...cfg, requiredLanes: ['Emulators · Vitest (functions) + E2E (shared)'] };
  const v = checksVerdict(stale, { ciWillRun: true }, guarded);
  assert.equal(v.state, 'red');
  assert.match(v.failures[0].why, /required lane/);

  // And a required lane is only required when CI was meant to run at all.
  assert.equal(checksVerdict(stale, { ciWillRun: false }, guarded).state, 'green');
});
