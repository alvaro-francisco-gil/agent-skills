#!/usr/bin/env node
/**
 * `pnpm pr:land` — the autonomous landing loop.
 *
 * NOT a merge command. A resumable state machine: run it, it advances the PR as
 * far as it can, then exits with a code telling the caller what to do next. Run
 * it again after fixing. Same-input runs are idempotent — it reuses an existing
 * PR rather than opening a second one.
 *
 *   0   merged; remote branch deleted; the worktree is REPORTED as reapable,
 *       not removed — a process cannot delete the directory it runs in
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
 * A network or GitHub-side hiccup is NOT a verdict. This loop polls for up to
 * 90 minutes; treating one failed call as fatal means a momentary blip discards
 * a PR that is perfectly healthy — which is exactly what happened on the first
 * two real runs, both killed by `error connecting to api.github.com`.
 */
const TRANSIENT = /error connecting|connection reset|timeout|temporarily unavailable|502|503|504|rate limit|EAI_AGAIN|ETIMEDOUT|ECONNRESET/i;

/** Consecutive transient failures tolerated before giving up on the API itself. */
const MAX_TRANSIENT = 10;
let transientStreak = 0;

function onTransient(what, stderr) {
  transientStreak += 1;
  if (transientStreak > MAX_TRANSIENT) {
    bail(
      EXIT.NEEDS_HUMAN,
      `${what} failed ${MAX_TRANSIENT} times in a row with transient errors — the API, not this PR, is the problem.`,
      stderr,
    );
  }
  log(`  ⚠ transient API error (${transientStreak}/${MAX_TRANSIENT}), retrying — the PR is fine`);
}

/**
 * `gh pr checks` exits NON-ZERO in three very different situations: no check has
 * registered yet (a race for the first ~30s after opening a PR, and the normal
 * steady state for a PR whose paths dispatch no workflow); a transient API
 * failure; and a real error. Conflating them aborts on a PR that is merely young
 * or merely unlucky.
 *
 * Returns null for "nothing yet", 'retry' for "ask again shortly".
 */
function checksOrPending(pr) {
  const raw = gh(['pr', 'checks', String(pr), '--json', 'name,state,link'], { allowFail: true });
  if (raw && raw.__failed) {
    if (/no checks reported/i.test(raw.stderr)) { transientStreak = 0; return null; }
    if (TRANSIENT.test(raw.stderr)) { onTransient('gh pr checks', raw.stderr); return 'retry'; }
    throw new Error(`gh pr checks failed:\n${raw.stderr}`);
  }
  transientStreak = 0;
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
    // Distinguish "this already landed" from "you have nothing to land". After a
    // successful merge the branch is legitimately zero ahead, and a re-run must
    // report success rather than a preflight failure.
    const merged = gh(
      ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number', '--jq', '.[0].number'],
      { allowFail: true },
    );
    if (merged && !merged.__failed && merged) {
      done(`#${merged} already landed — branch is fully merged into ${CONFIG.baseBranch}`);
    }
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

/**
 * Pure: does CI's path filter cover any of this diff?
 *
 * `["**"]` means the repo's CI has NO path filter and always runs — say that
 * explicitly rather than listing every top-level directory, which silently
 * stops being true the moment someone adds one.
 */
function ciCovers(files, cfg = CONFIG) {
  if ((cfg.ciPaths || []).includes('**')) return files.length > 0;
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
    if ((CONFIG.ciPaths || []).includes('**')) {
      log(`  this repo's CI has no path filter — it runs on every PR.`);
    } else {
      const covered = touches(files, CONFIG.ciPaths);
      log(`  ${covered.length}/${files.length} changed path(s) are in CI's filter — CI will run.`);
    }
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

  // `gh pr create --label` hard-fails when the label does not exist in the repo,
  // which is the normal state the first time a repo adopts this loop. Create it
  // idempotently rather than aborting on a one-time setup detail.
  if (CONFIG.reviewLabel) {
    const made = gh(
      ['label', 'create', CONFIG.reviewLabel, '--description', 'Request an automated review', '--force'],
      { allowFail: true },
    );
    if (made && made.__failed) {
      log(`  ⚠ could not ensure the "${CONFIG.reviewLabel}" label exists — opening the PR without it.`);
      log('    A PR with no review label gets no review, so it will stop at exit 30.');
      CONFIG.reviewLabel = null;
    }
  }

  const subject = sh(`git log -1 --format=%s`);
  const body = [
    sh(`git log origin/${CONFIG.baseBranch}..HEAD --format='- %s'`),
    '',
    verification.note,
  ].join('\n');

  const url = gh([
    'pr', 'create',
    '--base', CONFIG.baseBranch,
    ...(CONFIG.reviewLabel ? ['--label', CONFIG.reviewLabel] : []),
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
    if (checks === 'retry') {
      sleep(CONFIG.pollIntervalMs);
      continue;
    }
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
    const raw = gh(['pr', 'view', String(pr), '--json', 'reviews'], { allowFail: true });
    if (raw && raw.__failed) {
      if (!TRANSIENT.test(raw.stderr)) throw new Error(`gh pr view failed:\n${raw.stderr}`);
      onTransient('gh pr view', raw.stderr);
      sleep(CONFIG.pollIntervalMs);
      continue;
    }
    transientStreak = 0;
    const reviews = (JSON.parse(raw || '{}').reviews || []).filter((r) => r.commit?.oid === headSha);

    const changes = reviews.filter((r) => r.state === 'CHANGES_REQUESTED');
    if (changes.length) {
      const rounds = (JSON.parse(raw || '{}').reviews || []).length;
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
        [
          '  Two very different situations produce this, and the script cannot tell them apart:',
          '',
          '  1. This repo has NO reviewer wired yet. Then exit 30 is the DESIGNED outcome, not a',
          '     failure — every step up to the merge is done and the PR is yours to merge. Leave',
          `     requireApprovingReview true: setting it false would merge on CI alone, which`,
          '     removes review rather than replacing it.',
          '  2. A reviewer IS wired and simply has not posted yet. It polls every ~15 min, and a PR',
          '     that dispatched no CI run relies on that backstop — re-run in a few minutes.',
          '',
          `  PR: ${gh(['pr', 'view', String(pr), '--json', 'url', '--jq', '.url'], { allowFail: true })}`,
        ].join('\n'),
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

/** Already merged? Then this run has nothing to do and must not report failure. */
function alreadyMerged(pr) {
  const raw = gh(['pr', 'view', String(pr), '--json', 'state'], { allowFail: true });
  if (raw && raw.__failed) return false;
  return JSON.parse(raw || '{}').state === 'MERGED';
}

function merge(pr, branch) {
  step('Merge');
  if (DRY_RUN) {
    log(`  [dry-run] would merge PR #${pr}`);
    return;
  }

  if (alreadyMerged(pr)) {
    log(`  #${pr} was already merged — nothing to do`);
  } else {
    // NOT `--delete-branch`: that makes gh check out the base branch locally
    // after merging, which fails outright when another worktree holds it —
    // the normal state here, since this contract tells agents to work in
    // worktrees. It failed AFTER the merge had already gone through, turning a
    // successful landing into exit 40. The remote branch is deleted below, and
    // `delete_branch_on_merge` on the repo covers it server-side regardless.
    gh(['pr', 'merge', String(pr), '--merge']);
    log(`  merged #${pr}`);
  }

  const deleted = gh(['api', '-X', 'DELETE', `repos/{owner}/{repo}/git/refs/heads/${branch}`], {
    allowFail: true,
  });
  log(deleted && deleted.__failed
    ? `  remote branch ${branch} already gone`
    : `  deleted remote ${branch}`);

  reportReap(branch);
}

/**
 * A process cannot remove the worktree it is standing in, so this reports the
 * cleanup rather than performing it. Saying so explicitly matters: worktrees
 * accumulate one per landed PR, and "the script cleans up" was claimed before it
 * was true — 14 had piled up in one repo by the time anyone checked.
 */
function reportReap(branch) {
  const gitDir = sh('git rev-parse --git-dir', { allowFail: true }) || '';
  const common = sh('git rev-parse --git-common-dir', { allowFail: true }) || '';
  const inWorktree = gitDir !== common;
  if (!inWorktree) {
    sh(`git branch -d ${branch}`, { allowFail: true });
    log(`  deleted local ${branch}`);
    return;
  }
  const wt = sh('git rev-parse --show-toplevel', { allowFail: true });
  const root = sh(`git -C "${common}/.." rev-parse --show-toplevel`, { allowFail: true });
  log('  this worktree is now stale — reap it from the main checkout:');
  // --force is REQUIRED, not defensive: `git worktree remove` refuses outright
  // on any worktree containing a submodule ("working trees containing
  // submodules cannot be moved or removed"), and this contract puts a submodule
  // in every repo that adopts it. Without --force the plain command always
  // fails here, which is how worktrees pile up.
  log(`    git -C ${root} worktree remove --force ${wt} && git -C ${root} branch -d ${branch}`);
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
