# Stands in for a Night shift orchestrator on the dev channel, so a run can be
# watched end to end without spending provider quota. See the development
# runbook's Night shift section for how the daemon is pointed at it.
$ErrorActionPreference = 'Stop'

function Night([string[]] $NightArgs) {
    Write-Output ("hs-night " + ($NightArgs -join ' '))
    & hs-night @NightArgs
}

Write-Output "fake orchestrator: run folder $env:HOUSTON_NIGHT_RUN_DIR"
Start-Sleep -Seconds 5
Night @('plan', '--title', 'Fake: tighten the attach path', '--theme', 'reliability')
Night @('plan', '--title', 'Fake: cache the diff', '--theme', 'performance', '--deferred')
Night @('pr', '--number', '1', '--title', 'Fake pull request', '--theme', 'reliability', '--checks', 'passed', '--review', 'passed', '--ci', 'pending', '--visible')
Night @('lesson', '--title', 'Fake lesson', '--body', 'Recorded by the dev fake orchestrator')
Night @('lesson', '--title', 'Fake flaky test', '--flaky-test', 'fake::flaky_test')
Night @('decision', '--title', 'Fake decision: keep the old API?', '--options', 'keep|remove')
$report = Join-Path $env:HOUSTON_NIGHT_RUN_DIR 'report.md'
"# Fake Night shift report`n`nOne fake pull request and one parked decision.`n" | Set-Content -Encoding utf8 -Path $report
Night @('report', '--summary', 'Fake run: 1 PR, 1 decision', '--merge-order', '1')
Write-Output 'fake orchestrator: waiting for the wrap-up instruction or the hard stop'
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { Start-Sleep -Seconds 3600 } else { Write-Output "received: $line" }
}
