#!/usr/bin/env bash
# Stands in for a Night shift orchestrator on the dev channel, so a run can be
# watched end to end without spending provider quota. See the development
# runbook's Night shift section for how the daemon is pointed at it.
set -euo pipefail

night() {
  echo "hs-night $*"
  hs-night "$@"
}

echo "fake orchestrator: run folder $HOUSTON_NIGHT_RUN_DIR"
sleep 5
night plan --title 'Fake: tighten the attach path' --theme reliability
night plan --title 'Fake: cache the diff' --theme performance --deferred
night pr --number 1 --title 'Fake pull request' --theme reliability --checks passed --review passed --ci pending --visible
night lesson --title 'Fake lesson' --body 'Recorded by the dev fake orchestrator'
night lesson --title 'Fake flaky test' --flaky-test fake::flaky_test
night decision --title 'Fake decision: keep the old API?' --options 'keep|remove'
printf '# Fake Night shift report\n\nOne fake pull request and one parked decision.\n' > "$HOUSTON_NIGHT_RUN_DIR/report.md"
night report --summary 'Fake run: 1 PR, 1 decision' --merge-order 1
echo 'fake orchestrator: waiting for the wrap-up instruction or the hard stop'
exec cat
