# Papercuts found in review (fix in the owning commit)

- [c6 settings] Settings row descriptions now wrap at ~400px (before: full row width). Seen in settings/appearance after tokens. Check DetailRow (components/ui/SettingsDetail.tsx:98) width split.
- [c3 rows] Paper selected rail row fill reads much darker than the mock (--sel rgba(0,0,0,.09)). rail/card-modes-expanded.
- [c9 cleanup] Machine-value mono used for words: "Default" / "Light" badges in the chrome theme cards.
- [c3 chips/status text] Paper warn text ("Hooks need repair", settings/agents-clis) reads low-contrast on white; check --warn text ink >= 4.5:1.
- [c9 cleanup] Hard-coded uppercase survives sentence-case tokens: roster group labels ("WAITING ON ORCHESTRATOR", "STALLED", "IDLE" in panes/lifecycle) and delegation badges ("ASKED ORCHESTRATOR", "WORKING", "FAILED" in orchestration/delegation-panels).
- [c5 header] statusGlyphState maps exited -> error regardless of exit code; exit 0 should read finished, non-zero error ("Exited with code N").
- [c9] settings/appearance: gap under the Chrome theme cards is ~50px vs the 24px group rhythm elsewhere.
- [follow-up issue, not this PR] BrowserSurface lost the persist-error warning band in the side-panel refactor; the story now shows the crash surface.
- [c0b] paper/shell-a/files-graphite failed once with `transformCallback` undefined (Tauri invoke) in review/1; not in review/0. Recheck after 0b.
