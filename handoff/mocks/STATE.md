# Full-redesign mock: paused state

- Integration branch feat/design-native (worktree design-native) HEAD 480489cb, nothing pushed. Gate green except
  check:bundle (970,241 vs cap 963,300): re-cut when the redesign is done.
- Mock: houston-mocks.base.html + fragments/*.html, merged by build-mock.py; shot-views.mjs captures views.
  Pre-redesign copy: houston-mocks.before-full-redesign.html. Brief: brief-mock-fragment.md; inventory.md.
- Fragments (all panes killed at the usage limit):
  - browser: done, 37 views; A/B browser chrome and side-panel tabs need a pick; composer host is a guess.
  - prs: done, 62 views; A/B list+detail need a pick; paper only partly reviewed.
  - side: 107 views, builds clean; apple-design and visual review NOT done; A/B panel structure.
  - rail: 67 views, builds clean; ~30 reviewed; known bugs: settings-none rows not hidden, add-pane marks blank.
    Open: drop "Agent activity" sort? "Cards show"/Layout panel still present.
  - settings, nav, orch: written but cut off by the rate limit; no result submitted; state unknown.
- Next: build all, fix page errors, finish reviews (apple-design on everything), user picks A/B, then implement.
