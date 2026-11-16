// Tests for scripts/pr-land-bg.sh: the tmux launch against a real, private tmux
// server, and --status / --kill against real processes.
//
// A tmux server keeps the working directory it started in for good. Once that
// directory is deleted (a worktree reaped by its own lander), `-c` no longer
// reaches new panes, and every lander started from that server dies on
// `uv_cwd: ENOENT` before it opens a PR.
//
// --kill is the documented way to stop a lander before it merges on an unfixed
// finding, so it must find THIS worktree's lander and touch nothing else: not
// another worktree's lander, and not a process that merely mentions the path.
// The scripts run under whatever `bash` is on PATH, which on macOS is 3.2 with no
// /proc — the shape that once made both flags die with `mapfile: command not found`.
//
// Run with: node --test scripts/__tests__/pr-land-bg.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'pr-land-bg.sh');
const hasTmux = spawnSync('tmux', ['-V']).status === 0;

test('lands from the worktree even when the tmux server lost its own directory', { skip: !hasTmux }, async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-land-bg-')));
  const socketDir = path.join(base, 'tmux');
  const bin = path.join(base, 'bin');
  const repo = path.join(base, 'repo');
  const gone = path.join(base, 'gone');
  const seen = path.join(base, 'seen');
  for (const dir of [socketDir, bin, repo, gone]) fs.mkdirSync(dir);

  const { TMUX: _ignored, ...parentEnv } = process.env;
  const env = { ...parentEnv, TMUX_TMPDIR: socketDir, PATH: `${bin}:${process.env.PATH}` };
  t.after(() => {
    spawnSync('tmux', ['kill-server'], { env });
    fs.rmSync(base, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(bin, 'pnpm'), `#!/bin/sh\npwd -P > '${seen}'\n`, { mode: 0o755 });
  spawnSync('git', ['init', '-q'], { cwd: repo });
  spawnSync('git', ['-c', 'user.email=t@x', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: repo });

  assert.equal(spawnSync('tmux', ['new-session', '-d', '-s', 'keeper'], { cwd: gone, env }).status, 0);
  fs.rmdirSync(gone);

  const run = spawnSync('bash', [SCRIPT], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);

  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(seen) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.readFileSync(seen, 'utf8').trim(), repo);
});

function fixtureRepo(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  spawnSync('git', ['init', '-q'], { cwd: root });
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'pr-land.js'), 'setInterval(() => {}, 1000);\n');
  return root;
}

const started = [];
function start(cwd, cmd, args) {
  const child = spawn(cmd, args, { cwd, stdio: 'ignore', detached: true });
  started.push(child);
  return child.pid;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(predicate, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

const landBg = (cwd, flag) => spawnSync('bash', [SCRIPT, flag], { cwd, encoding: 'utf8' });

test('--status and --kill act on this worktree’s lander and nothing else', async () => {
  const here = fixtureRepo('land-bg-here-');
  const elsewhere = fixtureRepo('land-bg-other-');
  try {
    const lander = start(here, 'node', ['scripts/pr-land.js']);
    const othersLander = start(elsewhere, 'node', ['scripts/pr-land.js']);
    // Mention the path from inside this worktree without being a lander.
    const quotesPath = start(here, 'node', ['-e', 'setInterval(() => {}, 1000)', 'scripts/pr-land.js']);
    const shellMentions = start(here, 'sh', ['-c', 'sleep 300; echo scripts/pr-land.js']);

    const status = landBg(here, '--status');
    assert.equal(status.status, 0, status.stderr);
    const listed = status.stdout.match(/^\s*\d+/gm).map(Number);
    assert.deepEqual(listed, [lander]);

    const kill = landBg(here, '--kill');
    assert.equal(kill.status, 0, kill.stderr);
    assert.match(kill.stdout, new RegExp(`stopped ${lander}\\b`));
    assert.ok(await waitFor(() => !alive(lander)), 'the lander is gone');
    for (const pid of [othersLander, quotesPath, shellMentions]) {
      assert.ok(alive(pid), `pid ${pid} must survive another worktree's --kill`);
    }

    const after = landBg(here, '--status');
    assert.equal(after.status, 1, after.stdout);
    assert.match(after.stdout, /no lander running/);
  } finally {
    for (const child of started) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {}
    }
    fs.rmSync(here, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('--status with no lander reports none and exits 1; --kill is a no-op', () => {
  const root = fixtureRepo('land-bg-empty-');
  try {
    const status = landBg(root, '--status');
    assert.equal(status.status, 1, status.stderr);
    assert.match(status.stdout, /no lander running/);
    const kill = landBg(root, '--kill');
    assert.equal(kill.status, 0, kill.stderr);
    assert.match(kill.stdout, /no lander of this worktree to kill/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
