#!/usr/bin/env bash
# Run `pnpm pr:land` so it survives, and stop it without hitting anyone else's.
#
#   scripts/pr-land-bg.sh            # launch in a tmux window, print how to watch it
#   scripts/pr-land-bg.sh --status   # is a lander running for THIS worktree?
#   scripts/pr-land-bg.sh --kill     # stop THIS worktree's lander, wrapper and child
#   scripts/pr-land-bg.sh --attach   # watch the window
#
# Two things this exists to stop, both of which cost a real batch real hours:
#
# 1. A backgrounded lander gets reaped. `pnpm pr:land` polls CI for as long as the
#    heavy lane makes it, and `setsid nohup … &` did NOT survive — three landers
#    died mid-poll in one night, each leaving `EXIT=143` in a log. 143 is SIGTERM:
#    it says the process was killed, NOT that the PR reached a state. A tmux
#    window survives, and keeps the output to read afterwards.
#
# 2. Killing a lander by pattern kills everybody's. `pkill -f`/`pgrep -f` match
#    the calling shell too (that is the mystery exit 144), and every worktree on
#    this machine runs its own lander during a batch — one sweep took out three.
#    Worse, killing the pnpm wrapper alone ORPHANS the `node scripts/pr-land.js`
#    child, which keeps polling and can merge a head that lacks your latest
#    commit while your log says the run died.
set -euo pipefail

# The lander as it appears in argv, not as a substring of a command line.
readonly LANDER='scripts/pr-land.js'

usage() { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; }

repo_root() { git rev-parse --show-toplevel; }

# A stable, filesystem-safe window name per worktree, so two worktrees landing at
# once cannot collide and neither can guess it is the other's.
window_name() { echo "land-$(basename "$(repo_root)")"; }

# Every lander whose working directory is inside THIS worktree — the pnpm `sh -c`
# wrapper and its node child alike — one pid per line, ascending.
#
# Selection is deliberately NOT a substring match on the command line. `pgrep -f
# scripts/pr-land.js` also matches any process that merely MENTIONS the path — an
# editor, a grep, the calling shell, and (measured, which is how this was caught
# before it shipped) a Claude session carrying these very instructions in its
# prompt. A --kill built on that would kill the agent instead of the lander.
#
# So the whole command line must BE a lander (`is_lander_cmdline`), then the pid is
# filtered by cwd. A pid that exits mid-scan, or whose cwd we may not read, is
# skipped, never fatal, or a stale pid would abort a --kill with real work to do.
#
# Portable on purpose: macOS ships bash 3.2 (no mapfile, and `"${a[@]}"` of an
# empty array is fatal under `set -u`), no /proc and no `tac`. `ps -A -ww -o args=`
# and `process_cwd` are the only process facts read, and both work on both.
landers_here() {
  local root pid args cwd
  root="$(repo_root)"
  ps -A -ww -o pid= -o args= | while read -r pid args; do
    is_lander_cmdline "$args" || continue
    cwd="$(process_cwd "$pid")" || continue
    if [[ "$cwd" == "$root" || "$cwd" == "$root"/* ]]; then echo "$pid"; fi
  done | sort -n
}

# The two shapes a lander takes, as whole command lines: the node child
# (`node [<dir>/]scripts/pr-land.js [args]`) and, where the shell does not exec it,
# pnpm's wrapper (`sh -c 'node scripts/pr-land.js [args]'`). argv[0] must itself be
# node or a POSIX shell, so a grep, an editor or an agent quoting the path never
# matches. Paths are taken to contain no spaces; pnpm passes the relative one.
is_lander_cmdline() {
  local bin='([^ ]*/)?' script='([^ ]*/)?scripts/pr-land\.js( .*)?$'
  local node_child="^${bin}(node|nodejs) ${script}"
  local sh_wrapper="^${bin}(sh|bash|dash) -c ${bin}node ${script}"
  [[ "$1" =~ $node_child || "$1" =~ $sh_wrapper ]]
}

# /proc where there is one (Linux); lsof where there is not (macOS).
process_cwd() {
  if [[ -d /proc/$1 ]]; then
    readlink "/proc/$1/cwd" 2>/dev/null
  else
    lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | grep .
  fi
}

# A newline-separated pid list in reverse, without `tac` (absent on macOS).
reverse_lines() { awk '{ line[NR] = $0 } END { for (i = NR; i > 0; i--) print line[i] }'; }

case "${1:-}" in
  --help|-h) usage; exit 0 ;;

  --status)
    pids="$(landers_here)"
    if [[ -z "$pids" ]]; then
      echo "no lander running for $(repo_root)"
      exit 1
    fi
    echo "lander running for $(repo_root):"
    ps -ww -o pid=,etime=,args= -p "$(echo "$pids" | paste -sd, -)"
    ;;

  --kill)
    pids="$(landers_here)"
    if [[ -z "$pids" ]]; then
      echo "no lander of this worktree to kill (other worktrees' landers left alone)"
      exit 0
    fi
    # TERM the child before its wrapper: the reverse order is what orphans it.
    for pid in $(echo "$pids" | reverse_lines); do
      kill "$pid" 2>/dev/null && echo "stopped $pid" || true
    done
    sleep 1
    survivors="$(landers_here)"
    if [[ -n "$survivors" ]]; then
      echo "still alive after TERM, sending KILL:" $survivors
      kill -9 $survivors 2>/dev/null || true
    fi
    tmux kill-session -t "$(window_name)" 2>/dev/null || true
    ;;

  --attach) exec tmux attach -t "$(window_name)" ;;

  '')
    root="$(repo_root)"
    win="$(window_name)"

    if [[ -n "$(landers_here)" ]]; then
      echo "a lander is already polling for $root — not starting a second one." >&2
      echo "  watch it:  $0 --attach        stop it:  $0 --kill" >&2
      exit 1
    fi
    # A lander commits and pushes; a tree changing under it is how a run exits 40.
    if [[ -n "$(git status --porcelain)" ]]; then
      echo "working tree is dirty — commit first, then land." >&2
      git status --short >&2
      exit 1
    fi

    tmux has-session -t "$win" 2>/dev/null || tmux new-session -d -s "$win" -c "$root"
    # `-c` alone is not enough: a tmux server whose own directory was deleted (a
    # reaped worktree) starts panes there, and the lander dies on uv_cwd ENOENT.
    tmux new-window -t "$win" -c "$root" \
      "cd $(printf '%q' "$root") && pnpm pr:land; code=\$?; echo; echo \"=== pr:land exit \$code ===\"; \
       echo '0 merged · 10 CI red · 20 changes requested · 30 hand to a human · 40 preflight'; \
       echo '143 is SIGTERM — not an outcome. Read GitHub: gh pr view <n> --json state,mergedAt'; \
       sleep 100000"
    echo "landing in tmux session '$win' (cwd $root)"
    echo "  watch:  $0 --attach"
    echo "  stop:   $0 --kill"
    echo "  state:  gh pr view <n> --json state,mergedAt   # never trust the log alone"
    ;;

  *) usage >&2; exit 2 ;;
esac
