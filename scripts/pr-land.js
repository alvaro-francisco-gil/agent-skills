#!/usr/bin/env node
/**
 * `pnpm pr:land` — the autonomous landing loop.
 *
 * NOT a merge command. A resumable state machine: run it, it advances the PR as
 * far as it can, then exits with a code telling the caller what to do next. Run
 * it again after fixing. Same-input runs are idempotent — it reuses an existing
 * PR rather than opening a second one.
 *
 *   0   merged, branch deleted, worktree reapable
 *   10  CI red (failures printed) — fix, re-run
 *   20  review requested changes (findings printed) — fix the cause, re-run
 *   30  hard-stop, or review rounds exhausted — hand to a human, do NOT retry
 *   40  preflight failed (dirty tree, wrong branch, conflict) — resolve, re-run
 *
 * Design notes that are load-bearing:
 *
 * - **Vacuous green is not green.** CI is usually path-filtered, so a PR touching
 *   only docs or infra dispatches no run at all. "No CI ran" must never be read as
 *   "CI passed" — such a PR is marked UNVERIFIED in its body and still requires an
 *   approving review to land.
 *
 * - **Staleness is semantic, not chronological.** Rebase only when the base's
 *   changed paths actually intersect this PR's, or touch a shared blast radius. A
 *   chronologically stale branch whose paths do not intersect is still validly
 *   green, and re-running CI for it buys nothing. Where CI runs on billed runners
 *   this saves money; where it runs on a self-hosted box it saves the scarcer
 *   resource, contention on the heavy lane.
 *
 * - **All repo-specific values are DATA, in `.agents/land.config.json`.** This file
 *   is shared verbatim across repos via the `agent-skills` submodule; if you find
 *   yourself editing it for one repo, that value belongs in the config instead.
 */
'use strict';

const { execFileSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Config
//
// Defaults below are deliberately conservative — an unconfigured repo gets an
// EMPTY hardStop list and requireApprovingReview:true, so it fails closed at the
// review gate rather than silently auto-merging a rules change it never declared.
// Each repo overrides via `.agents/land.config.json` at its root:
//
//   {
//     "baseBranch": "develop",
//     "reviewLabel": "ai-review",
//     "requireApprovingReview": true,
//     "ciPaths": ["src/", "package.json"],
//     "hardStop": [{ "pattern": "^firestore\\.rules$", "why": "security rules" }],
//     "sharedBlastRadius": ["packages/shared/", "pnpm-lock.yaml"]
//   }
//
// `pattern` is a JS regex SOURCE string (not /slashes/); add "flags" for /i.
// ---------------------------------------------------------------------------

const DEFAULTS = {
  baseBranch: 'develop',
  reviewLabel: 'ai-review',
  /** Merge bar. Set false only in repos with no automated reviewer — a weaker gate. */
  requireApprovingReview: true,
  maxReviewRounds: 5,
  /** Paths that trigger a CI run. Must mirror the repo's CI path filter. */
  ciPaths: [],
  /**
   * Changes that always return to a human before merge, however green.
   * "Green" answers "did the tests pass", not "is the blast radius acceptable".
   */
  hardStop: [],
  /** A commit trailer declaring a break for already-installed clients. */
  hardStopTrailerSource: '^Breaking-Client:',
  /**
   * Paths whose churn can break an unrelated PR, so a base move here always
   * forces a rebase even with no direct file overlap.
   */
  sharedBlastRadius: [],
  pollIntervalMs: 20_000,
  checksTimeoutMs: 90 * 60 * 1000,
  reviewTimeoutMs: 20 * 60 * 1000,
};

const CONFIG_FILENAME = '.agents/land.config.json';

function loadConfig(repoRoot = process.cwd()) {
  const file = path.join(repoRoot, CONFIG_FILENAME);
  let overrides = {};
  if (fs.existsSync(file)) {
    try {
      overrides = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`${CONFIG_FILENAME} is not valid JSON: ${err.message}`);
    }
  }
  const merged = { ...DEFAULTS, ...overrides };
  merged.hardStop = (merged.hardStop || []).map((rule) => ({
    why: rule.why,
    pattern: rule.pattern instanceof RegExp ? rule.pattern : new RegExp(rule.pattern, rule.flags || ''),
  }));
  merged.hardStopTrailer = new RegExp(merged.hardStopTrailerSource, 'm');
  merged.configFound = fs.existsSync(file);
  return merged;
}

const CONFIG = loadConfig(sh0('git rev-parse --show-toplevel'));

/** Minimal exec used before the main helper exists, so config can load first. */
function sh0(cmd) {
  try {
    return require('node:child_process').execSync(cmd, { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

const EXIT = { MERGED: 0, CI_RED: 10, CHANGES_REQUESTED: 20, NEEDS_HUMAN: 30, PREFLIGHT: 40 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DRY_RUN = process.argv.includes('--dry-run');

function sh(cmd, { allowFail = false } = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`command failed: ${cmd}\n${err.stderr || err.message}`);
  }
}

function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFail) return { __failed: true, stderr: String(err.stderr || err.message) };
    throw new Error(`gh ${args.join(' ')} failed:\n${err.stderr || err.message}`);
  }
}

/**
 * `gh pr checks` exits NON-ZERO in two very different situations: no check has
 * registered yet (a race for the first ~30s after opening a PR, and the normal
 * steady state for a PR whose paths dispatch no workflow), and a real API
 * failure. Conflating them makes the loop abort on a PR that is merely young.
 */
function checksOrPending(pr) {
  const raw = gh(['pr', 'checks', String(pr), '--json', 'name,state,link'], { allowFail: true });
  if (raw && raw.__failed) {
    if (/no checks reported/i.test(raw.stderr)) return null;
    throw new Error(`gh pr checks failed:\n${raw.stderr}`);
  }
  return JSON.parse(raw || '[]');
}

const log = (msg) => console.log(msg);
const step = (msg) => console.log(`\n▸ ${msg}`);

function bail(code, msg, detail) {
  console.error(`\n✗ ${msg}`);
  if (detail) console.error(detail);
  console.error(`\n→ exit ${code}`);
  process.exit(code);
}

function done(msg) {
  console.log(`\n✓ ${msg}\n→ exit 0`);
  process.exit(EXIT.MERGED);
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Files changed on this branch relative to where it forked from the base. */
function changedFiles(base, head = 'HEAD') {
  const mergeBase = sh(`git merge-base ${base} ${head}`);
  const out = sh(`git diff --name-only ${mergeBase} ${head}`);
  return out ? out.split('\n').filter(Boolean) : [];
}

const touches = (files, prefixes) =>
  files.filter((f) => prefixes.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function preflight() {
  step('Preflight');

  if (!CONFIG.configFound) {
    log(`  ⚠ no ${CONFIG_FILENAME} — running on defaults: no hard-stop list, no CI path map.`);
    log('    Add one before relying on this in anger; the defaults fail closed, not open.');
  }

  const branch = sh('git rev-parse --abbrev-ref HEAD');
  const protectedBranches = [CONFIG.baseBranch, ...(CONFIG.protectedBranches || ['beta', 'main', 'master']), 'HEAD'];
  if (protectedBranches.includes(branch)) {
    bail(EXIT.PREFLIGHT, `Refusing to land from "${branch}". Work happens on a feature branch.`);
  }

  const dirty = sh('git status --porcelain');
  if (dirty) {
    bail(EXIT.PREFLIGHT, 'Working tree is dirty. Commit or stash first.', dirty);
  }

  sh(`git fetch origin ${CONFIG.baseBranch} --prune`);

  const ahead = sh(`git rev-list --count origin/${CONFIG.baseBranch}..HEAD`);
  if (ahead === '0') {
    bail(EXIT.PREFLIGHT, `No commits ahead of origin/${CONFIG.baseBranch} — nothing to land.`);
  }

  log(`  branch: ${branch} (${ahead} commit(s) ahead of ${CONFIG.baseBranch})`);
  return branch;
}

/**
 * Pure: which changed paths (and/or commit trailers) put this PR behind a human.
 * Kept side-effect free so it is directly testable — the gate that decides
 * whether a rules change can self-merge deserves assertions, not a smoke test.
 */
function hardStopHits(files, commitMessages = '', cfg = CONFIG) {
  const hits = [];
  for (const f of files) {
    for (const rule of cfg.hardStop) {
      if (rule.pattern.test(f)) hits.push(`${f} — ${rule.why}`);
    }
  }
  if (cfg.hardStopTrailer.test(commitMessages)) {
    hits.push('commit carries a Breaking-Client: trailer — walls installed clients');
  }
  return hits;
}

/** Pure: does CI's path filter cover any of this diff? */
function ciCovers(files, cfg = CONFIG) {
  return touches(files, cfg.ciPaths).length > 0;
}

/**
 * Pure: has the base moved *into this diff's territory*? Chronological staleness
 * alone is not a reason to burn a CI run — see the header note.
 */
function needsRebase(baseChangedFiles, prFiles, cfg = CONFIG) {
  const overlap = baseChangedFiles.filter((f) => prFiles.includes(f));
  const blast = touches(baseChangedFiles, cfg.sharedBlastRadius);
  return { overlap, blast, rebase: overlap.length > 0 || blast.length > 0 };
}

/** Refuse to auto-merge anything whose blast radius outlives a green test run. */
function hardStopCheck(files) {
  step('Hard-stop check');

  const trailers = sh(`git log origin/${CONFIG.baseBranch}..HEAD --format=%B`);
  const hits = hardStopHits(files, trailers);

  if (hits.length) {
    log('  ⚠ this PR needs a human decision to merge:');
    for (const h of hits) log(`    · ${h}`);
  } else {
    log('  clear — no gated paths touched');
  }
  return hits;
}

/**
 * Decide whether CI will actually cover this diff. Returns a note recorded in
 * the PR body, so "nothing ran" is visible rather than silently reading green.
 */
function verificationNote(files) {
  step('Verification coverage');

  if (ciCovers(files)) {
    const covered = touches(files, CONFIG.ciPaths);
    log(`  ${covered.length}/${files.length} changed path(s) are in CI's filter — CI will run.`);
    return { ciWillRun: true, note: 'CI covers this diff.' };
  }

  log('  ⚠ NO path in this diff matches CI\'s filter — no run will be dispatched.');
  log('    "No CI ran" is not "CI passed". Landing rests on review alone.');
  return {
    ciWillRun: false,
    note:
      '⚠ **UNVERIFIED BY CI** — no changed path matches `develop-tests.yml`\'s filter, ' +
      'so no run was dispatched. This PR is gated on review only.',
  };
}

function ensurePr(branch, verification) {
  step('Pull request');

  const existing = gh(['pr', 'list', '--head', branch, '--json', 'number,url', '--jq', '.[0].number']);
  if (existing) {
    log(`  reusing PR #${existing}`);
    sh(`git push origin ${branch}`, { allowFail: true });
    return existing;
  }

  if (DRY_RUN) {
    log('  [dry-run] would push and open a PR');
    return null;
  }

  sh(`git push -u origin ${branch}`);

  const subject = sh(`git log -1 --format=%s`);
  const body = [
    sh(`git log origin/${CONFIG.baseBranch}..HEAD --format='- %s'`),
    '',
    verification.note,
  ].join('\n');

  const url = gh([
    'pr', 'create',
    '--base', CONFIG.baseBranch,
    '--label', CONFIG.reviewLabel,
    '--title', subject,
    '--body', body,
  ]);
  log(`  opened ${url}`);
  return url.split('/').pop();
}

function watchChecks(pr, verification) {
  step('CI');

  if (!verification.ciWillRun) {
    log('  skipped — no CI lane matches this diff (see above).');
    return;
  }

  const deadline = Date.now() + CONFIG.checksTimeoutMs;
  for (;;) {
    const checks = checksOrPending(pr);
    if (checks === null) {
      if (Date.now() > deadline) {
        bail(EXIT.NEEDS_HUMAN, 'No check ever registered on this PR, though its paths should dispatch one.');
      }
      log('  waiting… no check has registered yet');
      sleep(CONFIG.pollIntervalMs);
      continue;
    }
    const relevant = checks.filter((c) => c.state !== 'SKIPPED' && c.state !== 'NEUTRAL');

    const failed = relevant.filter((c) => ['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(c.state));
    if (failed.length) {
      bail(
        EXIT.CI_RED,
        'CI is red.',
        failed.map((c) => `  · ${c.name}\n    ${c.link}`).join('\n') +
          '\n\n  Read the log before assuming it is your code — an infrastructure failure ' +
          '(e.g. the runner pnpm cache) is not a regression to "fix".',
      );
    }

    const pending = relevant.filter((c) => ['PENDING', 'QUEUED', 'IN_PROGRESS'].includes(c.state));
    if (!pending.length && relevant.length) {
      log(`  green (${relevant.length} check(s))`);
      return;
    }

    if (Date.now() > deadline) {
      bail(EXIT.NEEDS_HUMAN, 'CI did not settle within the timeout. Investigate the run by hand.');
    }
    log(`  waiting… ${pending.length} pending`);
    sleep(CONFIG.pollIntervalMs);
  }
}

function awaitReview(pr) {
  step('Review');

  if (!CONFIG.requireApprovingReview) {
    log('  not required in this repo');
    return;
  }

  const headSha = sh('git rev-parse HEAD');
  const deadline = Date.now() + CONFIG.reviewTimeoutMs;

  for (;;) {
    const raw = gh(['pr', 'view', String(pr), '--json', 'reviews']);
    const reviews = (JSON.parse(raw || '{}').reviews || []).filter((r) => r.commit?.oid === headSha);

    const changes = reviews.filter((r) => r.state === 'CHANGES_REQUESTED');
    if (changes.length) {
      const rounds = (JSON.parse(gh(['pr', 'view', String(pr), '--json', 'reviews'])).reviews || []).length;
      if (rounds >= CONFIG.maxReviewRounds) {
        bail(
          EXIT.NEEDS_HUMAN,
          `Review rounds exhausted (${rounds}/${CONFIG.maxReviewRounds}). Summarise the open findings and hand off.`,
        );
      }
      bail(
        EXIT.CHANGES_REQUESTED,
        'Review requested changes.',
        changes.map((r) => r.body).join('\n---\n') +
          '\n\n  Fix the cause, not the symptom. Do not silence the finding.',
      );
    }

    if (reviews.some((r) => r.state === 'APPROVED')) {
      log(`  approved @ ${headSha.slice(0, 8)}`);
      return;
    }

    if (Date.now() > deadline) {
      bail(
        EXIT.NEEDS_HUMAN,
        'No review landed on this head SHA within the timeout.',
        '  The reviewer polls every ~15 min; a PR that dispatched no CI run relies on that backstop.',
      );
    }
    log('  waiting for a review on this commit…');
    sleep(CONFIG.pollIntervalMs);
  }
}

/**
 * Rebase only when the base actually moved *into* this diff's territory.
 * A chronologically stale branch whose paths do not intersect is still validly
 * green, and re-running CI for it buys nothing.
 */
function stalenessCheck(branch, files) {
  step('Staleness');

  sh(`git fetch origin ${CONFIG.baseBranch} --prune`);
  const mergeBase = sh(`git merge-base origin/${CONFIG.baseBranch} HEAD`);
  const baseTip = sh(`git rev-parse origin/${CONFIG.baseBranch}`);

  if (mergeBase === baseTip) {
    log('  up to date with base');
    return false;
  }

  const baseChanged = sh(`git diff --name-only ${mergeBase} ${baseTip}`).split('\n').filter(Boolean);
  const { overlap, blast, rebase } = needsRebase(baseChanged, files);

  if (!rebase) {
    log(`  base moved ${baseChanged.length} file(s), none intersecting this diff — green still holds, no rebase`);
    return false;
  }

  log(`  base moved into this diff's territory (${overlap.length} overlap, ${blast.length} shared) — rebasing`);
  if (DRY_RUN) return true;

  try {
    sh(`git rebase origin/${CONFIG.baseBranch}`);
  } catch (err) {
    sh('git rebase --abort', { allowFail: true });
    bail(EXIT.PREFLIGHT, 'Rebase hit a conflict. Resolve it by hand, then re-run.', err.message);
  }
  sh(`git push --force-with-lease origin ${branch}`);
  log('  rebased and pushed — re-run to re-verify against the new base');
  return true;
}

function merge(pr, branch) {
  step('Merge');
  if (DRY_RUN) {
    log(`  [dry-run] would merge PR #${pr}`);
    return;
  }
  gh(['pr', 'merge', String(pr), '--merge', '--delete-branch']);
  log(`  merged #${pr}, deleted ${branch}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (DRY_RUN) log('[dry-run] no push, no PR, no merge\n');

  const branch = preflight();
  const files = changedFiles(`origin/${CONFIG.baseBranch}`);
  log(`  ${files.length} file(s) changed`);

  const gated = hardStopCheck(files);
  const verification = verificationNote(files);
  const pr = ensurePr(branch, verification);
  if (!pr) done('dry-run complete');

  watchChecks(pr, verification);
  awaitReview(pr);

  if (stalenessCheck(branch, files)) {
    bail(
      EXIT.CI_RED,
      'Rebased onto a moved base. CI and review must re-run against the new head.',
      '  Re-run `pnpm pr:land` — this is expected, not a failure.',
    );
  }

  if (gated.length) {
    bail(
      EXIT.NEEDS_HUMAN,
      'Green and approved, but this PR is gated — a human merges it.',
      gated.map((h) => `  · ${h}`).join('\n') +
        `\n\n  PR: ${gh(['pr', 'view', String(pr), '--json', 'url', '--jq', '.url'])}`,
    );
  }

  merge(pr, branch);
  done(`landed #${pr}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    bail(EXIT.PREFLIGHT, err.message);
  }
}

module.exports = { CONFIG, DEFAULTS, EXIT, loadConfig, hardStopHits, ciCovers, needsRebase, touches };
