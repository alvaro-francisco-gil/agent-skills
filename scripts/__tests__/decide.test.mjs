import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decide, EXIT, ACTION } = require('../decide.js');

// The point of extracting decide(): the ENTIRE decision table is now testable
// with no network, no git, no gh. The pipeline version could only be tested by
// running it against a real pull request, which is why all ten of its bugs were
// found in production — one of them by successfully merging.

/** A healthy PR one step from merging. Each test perturbs one field. */
const base = () => ({
  baseBranch: 'develop',
  requireApprovingReview: true,
  maxReviewRounds: 5,
  branch: {
    name: 'feat/x', headSha: 'abc', isProtected: false, dirty: false, dirtyFiles: '',
    rebaseConflict: false, ahead: 2, pushed: true, remoteBehind: false, inWorktree: true,
  },
  pr: { number: 7, state: 'open', url: 'https://example/7', isDraft: false, headSha: 'abc', reviews: [] },
  checks: { state: 'green', failures: [] },
  review: { state: 'approved', rounds: 1, body: '' },
  remoteBranchExists: true,
  files: ['src/a.ts'],
  ciWillRun: true,
  gated: [],
  base: { overlap: [], blast: [], needsRebase: false },
  checksDeadlinePassed: false,
  reviewDeadlinePassed: false,
});

const withState = (patch) => ({ ...base(), ...patch });

// --- the happy path ---------------------------------------------------------

test('green, approved, current and ungated → merge', () => {
  assert.equal(decide(base()).action, ACTION.MERGE);
});

// --- terminal states are checked FIRST --------------------------------------
//
// This ordering is the fix for the bug that reported a successfully merged PR as
// exit 40: a merged branch is legitimately 0 commits ahead, and its worktree may
// be anything at all. Preconditions must not run on an already-finished PR.

test('a merged PR whose remote branch is gone → exit 0', () => {
  const s = withState({ pr: { ...base().pr, state: 'merged' }, remoteBranchExists: false });
  assert.equal(decide(s).exit, EXIT.MERGED);
});

test('a merged PR whose remote branch remains → delete it, do not report failure', () => {
  const s = withState({ pr: { ...base().pr, state: 'merged' }, remoteBranchExists: true });
  assert.equal(decide(s).action, ACTION.DELETE_REMOTE);
});

test('merged wins over every precondition — 0 ahead, dirty, in a worktree', () => {
  const s = withState({
    pr: { ...base().pr, state: 'merged' },
    remoteBranchExists: false,
    branch: { ...base().branch, ahead: 0, dirty: true, dirtyFiles: 'M x' },
  });
  assert.equal(decide(s).exit, EXIT.MERGED, 'a landed PR must never be reported as a failure');
});

test('a closed-unmerged PR hands off rather than merging around the human', () => {
  const s = withState({ pr: { ...base().pr, state: 'closed' } });
  const d = decide(s);
  assert.equal(d.exit, EXIT.NEEDS_HUMAN);
  assert.match(d.detail, /do not merge around a human decision/);
});

// --- preconditions ----------------------------------------------------------

test('refuses to land from a protected branch', () => {
  const s = withState({ branch: { ...base().branch, isProtected: true, name: 'develop' } });
  assert.equal(decide(s).exit, EXIT.PREFLIGHT);
});

test('refuses on a dirty tree', () => {
  assert.equal(decide(withState({ branch: { ...base().branch, dirty: true } })).exit, EXIT.PREFLIGHT);
});

test('refuses mid-rebase', () => {
  assert.equal(decide(withState({ branch: { ...base().branch, rebaseConflict: true } })).exit, EXIT.PREFLIGHT);
});

test('no PR and nothing ahead → nothing to land', () => {
  const s = withState({ pr: { state: 'none', reviews: [] }, branch: { ...base().branch, ahead: 0 } });
  assert.equal(decide(s).exit, EXIT.PREFLIGHT);
});

// --- getting onto a PR ------------------------------------------------------

test('unpushed branch → push', () => {
  assert.equal(decide(withState({ branch: { ...base().branch, pushed: false } })).action, ACTION.PUSH);
});

test('remote behind local → push', () => {
  assert.equal(decide(withState({ branch: { ...base().branch, remoteBehind: true } })).action, ACTION.PUSH);
});

test('pushed but no PR → open one', () => {
  assert.equal(decide(withState({ pr: { state: 'none', reviews: [] } })).action, ACTION.OPEN_PR);
});

test('a draft PR hands off — drafts skip CI and review by design', () => {
  assert.equal(decide(withState({ pr: { ...base().pr, isDraft: true } })).exit, EXIT.NEEDS_HUMAN);
});

// --- verification -----------------------------------------------------------

test('red CI → exit 10, and says not to assume it is your code', () => {
  const s = withState({ checks: { state: 'red', failures: [{ name: 'Lint', link: 'l' }] } });
  const d = decide(s);
  assert.equal(d.exit, EXIT.CI_RED);
  assert.match(d.detail, /infrastructure failure/i);
});

test('pending CI → wait', () => {
  assert.equal(decide(withState({ checks: { state: 'pending', failures: [] } })).action, ACTION.WAIT_CHECKS);
});

test('no checks yet, but CI should run → wait, never read as green', () => {
  assert.equal(decide(withState({ checks: { state: 'none', failures: [] } })).action, ACTION.WAIT_CHECKS);
});

test('vacuous green: no CI lane matches, so `none` is the steady state → proceed on review', () => {
  const s = withState({ ciWillRun: false, checks: { state: 'none', failures: [] } });
  assert.equal(decide(s).action, ACTION.MERGE, 'an unverified PR still lands on an approving review');
});

test('CI that never settles hands off rather than waiting forever', () => {
  const s = withState({ checks: { state: 'pending', failures: [] }, checksDeadlinePassed: true });
  const d = decide(s);
  assert.equal(d.exit, EXIT.NEEDS_HUMAN);
  assert.match(d.detail, /starved of runners/);
});

// --- review -----------------------------------------------------------------

test('changes requested → exit 20 with the findings', () => {
  const s = withState({ review: { state: 'changes_requested', rounds: 1, body: 'finding' } });
  const d = decide(s);
  assert.equal(d.exit, EXIT.CHANGES_REQUESTED);
  assert.match(d.detail, /Fix the cause, not the symptom/);
});

test('rounds exhausted hands off instead of looping', () => {
  const s = withState({ review: { state: 'changes_requested', rounds: 5, body: 'x' } });
  assert.equal(decide(s).exit, EXIT.NEEDS_HUMAN);
});

test('awaiting review → wait', () => {
  assert.equal(decide(withState({ review: { state: 'none', rounds: 0, body: '' } })).action, ACTION.WAIT_REVIEW);
});

test('no review before the deadline names BOTH causes, not just the flattering one', () => {
  const s = withState({ review: { state: 'none', rounds: 0, body: '' }, reviewDeadlinePassed: true });
  const d = decide(s);
  assert.equal(d.exit, EXIT.NEEDS_HUMAN);
  assert.match(d.detail, /NO reviewer wired/);
  assert.match(d.detail, /has not posted yet/);
});

test('a repo with no reviewer requirement merges on green alone', () => {
  const s = withState({ requireApprovingReview: false, review: { state: 'none', rounds: 0, body: '' } });
  assert.equal(decide(s).action, ACTION.MERGE);
});

test('the merge reason never claims a review that was not required', () => {
  // The stated reason is the only record of what bar a merge actually cleared.
  // Two repos here run different bars, so a fixed "green and approved" string
  // would log a review that never happened in one of them.
  const noReview = withState({ requireApprovingReview: false, review: { state: 'none', rounds: 0, body: '' } });
  assert.doesNotMatch(decide(noReview).why, /approved/);
  assert.match(decide(noReview).why, /no review required/);
  assert.match(decide(base()).why, /approved/);
});

test('a gated PR reports the same bar it actually cleared', () => {
  const s = withState({ requireApprovingReview: false, review: { state: 'none', rounds: 0, body: '' }, gated: ['security rules'] });
  const d = decide(s);
  assert.equal(d.exit, EXIT.NEEDS_HUMAN);
  assert.doesNotMatch(d.why, /approved/);
});

// --- integration and the gate green cannot answer ---------------------------

test('base moved into this diff → rebase', () => {
  const s = withState({ base: { overlap: ['src/a.ts'], blast: [], needsRebase: true } });
  assert.equal(decide(s).action, ACTION.REBASE);
});

test('base moved elsewhere → no rebase, green still holds', () => {
  assert.equal(decide(base()).action, ACTION.MERGE);
});

test('gated paths hand off even when green, approved and current', () => {
  const s = withState({ gated: ['firestore.rules — security rules'] });
  const d = decide(s);
  assert.equal(d.exit, EXIT.NEEDS_HUMAN);
  assert.match(d.detail, /firestore\.rules/);
});

test('the gate is checked AFTER rebase — a stale gated PR rebases first', () => {
  const s = withState({
    gated: ['firestore.rules — security rules'],
    base: { overlap: ['x'], blast: [], needsRebase: true },
  });
  assert.equal(decide(s).action, ACTION.REBASE);
});

// --- purity -----------------------------------------------------------------

test('decide() does not mutate the state it is given', () => {
  const s = base();
  const snapshot = JSON.stringify(s);
  decide(s);
  assert.equal(JSON.stringify(s), snapshot);
});

// --- regressions from the reconciler's own first run ------------------------

test('SAFETY: a protected branch is refused even when a merged PR exists for it', () => {
  // Real incident. `--head develop` matched merged release PR #669 (develop →
  // beta), the terminal branch fired, and its follow-up action is a branch
  // DELETION — of develop. The protected guard must precede everything,
  // including the terminal check.
  const s = withState({
    branch: { ...base().branch, isProtected: true, name: 'develop' },
    pr: { ...base().pr, state: 'merged' },
    remoteBranchExists: true,
  });
  const d = decide(s);
  assert.equal(d.exit, EXIT.PREFLIGHT, 'must never reach the delete-branch action on a protected branch');
  assert.notEqual(d.action, ACTION.DELETE_REMOTE);
});

test('SAFETY: protected wins over every other terminal and precondition', () => {
  for (const patch of [
    { pr: { ...base().pr, state: 'closed' } },
    { branch: { ...base().branch, isProtected: true, dirty: true } },
    { checks: { state: 'red', failures: [] } },
  ]) {
    const s = withState({ ...patch, branch: { ...base().branch, ...(patch.branch || {}), isProtected: true } });
    assert.equal(decide(s).exit, EXIT.PREFLIGHT);
  }
});
