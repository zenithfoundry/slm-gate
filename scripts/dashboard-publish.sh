#!/usr/bin/env bash
# Publishes fresh dashboard numbers to GitHub Pages.
#
# HOW OFTEN IT RUNS
#   Once a day at 21:00 local time, when scheduled by the macOS launchd agent described
#   in docs/analytics-and-observability.md ("Keeping the published dashboard current").
#   The schedule itself lives in that agent's plist (StartCalendarInterval), not here;
#   change it there. If the Mac is asleep at 21:00, launchd runs the job once on wake;
#   several missed days still produce one run, not a backlog.
#   Run it by hand any time:  scripts/dashboard-publish.sh [--dry-run]
#
# WHAT IT DOES
#   1. Exports the dashboard numbers from the local ledger into a private temp folder.
#   2. Builds one commit on top of GitHub's main that changes only site/data.json.
#   3. Pushes that commit. The Pages workflow (.github/workflows/pages.yml) redeploys.
#
# SAFETY GUARDS
#   - Never touches your working copy. No checkout, pull, merge, stash or staging: the
#     commit is built with git plumbing in a throwaway index, so your current branch,
#     staged files and uncommitted work stay exactly as they are, and nothing can
#     conflict with them. The only local effect is a fetch of origin/main.
#   - Changes exactly one file, site/data.json, and verifies that before pushing.
#     site/index.html is never republished from here: an unfinished edit to the
#     dashboard page cannot reach the public site by timer.
#   - Never force-pushes. If main moved on GitHub since the fetch (or a second run won
#     the race), the push is rejected, nothing changes, and the next run retries.
#   - Skips the commit when the numbers are unchanged (the export's generatedAt stamp
#     is ignored), so idle days add no commits.
#   - Stops before committing if the export fails or is not valid JSON.
#   - Publishes aggregates only: the export holds counts, token sums, minutes and dates,
#     never prompts, tool names or skill names. No secrets are read or written here.
#   - Temp files are owner-only (umask 077) and deleted on exit, success or failure.
#
# After a publish your local main is one commit behind GitHub; `git pull` as usual.

set -euo pipefail
umask 077

readonly REMOTE=origin
readonly BRANCH=main
readonly DATA_PATH=site/data.json
readonly COMMIT_MESSAGE='chore(dashboard): refresh data'

log() { printf '%s dashboard-publish: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

dry_run=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."

# launchd starts jobs with a bare PATH; the agent's plist must supply one with pnpm on it.
command -v pnpm >/dev/null || { log "pnpm not found on PATH ($PATH)"; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git fetch --quiet "$REMOTE" "$BRANCH"
base="$(git rev-parse --verify "refs/remotes/$REMOTE/$BRANCH^{commit}")"

# The page must already be published by hand (see the docs); this job only refreshes data.
git cat-file -e "$base:site/index.html" 2>/dev/null \
  || { log "$REMOTE/$BRANCH has no site/index.html; publish the dashboard once by hand first"; exit 1; }

log "exporting from the local ledger"
pnpm run --silent dashboard:export -- --out "$tmp/site" >/dev/null

git show "$base:$DATA_PATH" > "$tmp/published.json" 2>/dev/null || : > "$tmp/published.json"

# Exit 0: numbers changed. Exit 3: unchanged apart from generatedAt. Anything else: bad export.
compare_exports='
const fs = require("node:fs");
const [fresh, published] = process.argv.slice(1).map(f => fs.readFileSync(f, "utf8"));
const withoutStamp = text => { const { generatedAt, ...rest } = JSON.parse(text); return JSON.stringify(rest); };
const next = withoutStamp(fresh);
let previous = null;
try { previous = withoutStamp(published); } catch { /* nothing published yet, or unreadable */ }
process.exit(next === previous ? 3 : 0);
'
if node -e "$compare_exports" "$tmp/site/data.json" "$tmp/published.json"; then
  :
else
  status=$?
  if [ "$status" -eq 3 ]; then
    log "numbers unchanged since the last publish; nothing to do"
    exit 0
  fi
  log "export is not valid JSON; refusing to publish"
  exit 1
fi

blob="$(git hash-object -w "$tmp/site/data.json")"
tree="$(
  export GIT_INDEX_FILE="$tmp/index"
  git read-tree "$base"
  git update-index --add --cacheinfo "100644,$blob,$DATA_PATH"
  git write-tree
)"
commit="$(git commit-tree "$tree" -p "$base" -m "$COMMIT_MESSAGE")"

changed="$(git diff-tree --no-commit-id --name-only -r "$base" "$commit")"
[ "$changed" = "$DATA_PATH" ] \
  || { log "refusing: commit would change more than $DATA_PATH: $changed"; exit 1; }

if $dry_run; then
  log "dry run: would push $commit onto $REMOTE/$BRANCH ($base)"
  git --no-pager show --stat --format='%h %s' "$commit"
  exit 0
fi

if ! git push --quiet "$REMOTE" "$commit:refs/heads/$BRANCH"; then
  log "push rejected ($REMOTE/$BRANCH probably moved); the next run will retry"
  exit 1
fi
log "published $commit; GitHub Pages will redeploy in about a minute"
