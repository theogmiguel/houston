# CSS conversion patterns

A cookbook for converting hand-written CSS to Tailwind utilities without losing
fidelity. Two governing facts everything below follows from: **unlayered CSS
beats layered CSS regardless of specificity or import order** (Tailwind's
utilities live in `@layer utilities`, so a converted element that still matches
a surviving unlayered rule keeps its old look, silently); and **jsdom implements
no CSS**, so a green test suite says nothing about whether a conversion
rendered — layout, animation and hover state rest on review and a real browser.

### 1. Shared rules move to a layer; only orphans get deleted
Problem: a rule with consumers across many files can't be deleted until the last
one converts, but leaving it in the unlayered sheet keeps beating every utility
that replaces it elsewhere.
Rule: wrap it in a shared `@layer` registered below the legacy base and above
`utilities`. Delete it outright — never re-layer it — the moment its last
consumer converts.

### 2. Prove "orphaned" with a word-boundary grep, never a substring
Problem: a substring match (`.seg` matching `header__strip-seg`) makes a still-used
class look dead.
Rule: grep for the class as a class, with word boundaries, across non-test
source, and check multi-selector rules (`.a, .b`) that mention it too. Paste
what you ran into the report.

### 3. Animation hooks survive the conversion
Problem: exit/entrance keyframes are often keyed off a wrapper class in
*descendant* position (`.anim-out .pop`); stripping the class from the
converted element silently kills the animation, invisible to every gate and to
a screenshot of the open state.
Rule: before removing any class, grep the stylesheet for it in descendant,
compound, and `@media` (especially reduced-motion) positions — not just as a
standalone rule. Prefer making the converted element self-contained
(`motion-safe:` on its own utility) over keeping the hook class alive in a file
scheduled for deletion.

### 4. A class lifted from a reference isn't guaranteed to generate CSS
Problem: copying a class name verbatim from a donor design (e.g.
`text-danger-foreground`) can silently emit nothing if the underlying token
doesn't exist in either theme.
Rule: after converting, grep the *built* stylesheet for every unusual utility
introduced and confirm a rule exists for it. Don't invent a theme token to make
a lifted class resolve — use one that already exists.

### 5. A donor's accent-token name is not necessarily your accent token
Problem: two design systems can map the same-sounding token (`--color-accent`)
to different meanings (a tinted surface vs. the brand color).
Rule: check what your `@theme` actually maps a token to before assuming a
utility family means what its name suggests in the source you're porting from.

### 6. Preflight changes what "restate the reset" means
Problem: with no CSS reset, a hand-written rule that explicitly zeroed
something (`padding: 0`) needs that zero restated as a utility or the user-agent
default reappears. Once a reset (e.g. Tailwind preflight) is turned on, blindly
restating every zero becomes noise at best and a silent override at worst if
the restated value disagrees with what the reset now provides.
Rule: per converted rule, ask (1) does the reset already set this property on
this element, (2) if yes and values agree, drop the restatement and log it as
reset-covered, (3) if yes and values disagree, keep it — it's now load-bearing
in a new way, (4) if no, restate it as before. A dropped restatement that
appears in no list is indistinguishable from one nobody thought about.

### 7. Convert what the page RENDERS, not what the stylesheet says
Problem: a declaration sitting in the source is not evidence it ever reached
the screen — an unlayered rule can permanently beat another rule's colors,
making "preserve the source text" produce a visible regression under the
banner of fidelity.
Rule: for any rule being replaced whose element also matches another rule,
compute both specificities or measure the actual computed style before
deciding what to preserve. Never trust source order or declaration text alone,
and don't accept a review finding that does either.

A sharper corollary: rescuing a converted declaration with `!important`
because "the surviving unlayered rule would otherwise win" is only right if
that surviving rule was actually winning at HEAD. If a third, higher-specificity
unlayered rule was already beating both, the declaration you're "rescuing" was
already dead — measure before reaching for `!`, an `!important` produces a
*confident* wrong answer that neither grep nor review can catch.

### 8. Ancestor-coupled rules don't convert inside one shard, in either direction
Problem: a rule like `.parent:hover .child` depends on a class (`group`) that
lives on an ancestor owned by a different file/shard. Converting only the child
half is impossible without touching the ancestor; converting the *other* rule
that an out-of-shard override depends on is worse — moving a base rule into
`@layer utilities` makes it beat every out-of-shard override regardless of the
specificity that used to settle their contest.
Rule: before converting any rule, grep for every other rule setting the same
property on the same element. If any of them lives outside your shard, leave
both sides in CSS and hand them to whichever shard owns the ancestor.

### 9. A design system's own spacing scale doesn't map identity-wise to Tailwind's
Problem: assuming your token step N equals Tailwind's utility step N (e.g.
`--space-5` = `p-5`) works for small steps and silently diverges above some
threshold, producing a per-axis error in a single shorthand that's easy to
miss.
Rule: build an explicit token→utility table from the actual pixel values and
convert through it, never by reading the digit. Grep your diff for the
utilities in the divergent range and re-derive each one from the token it
replaced.

### 10. A subsystem-owned stylesheet can be layered wholesale
Problem: per-rule migration into a shared layer doesn't scale to a large
stylesheet owned entirely by one subsystem — hundreds of individual moves, each
a chance to strand half a selector.
Rule: if a stylesheet is provably disjoint (no class styled by both sheets, no
bare element rules that would leak by inheritance, no override of a
third-party unlayered sheet), wrap the whole file in one `@layer` instead. A
layer's cascade position is fixed wherever it is FIRST encountered in the
*bundled* output, not by where its order is declared — so restate the
canonical `@layer a, b, c;` order statement at the top of any file that opens
a layer, since import order in the bundler is not something you control or can
trust.

### 11. A utility glued to a template-literal interpolation emits nothing
Problem: Tailwind scans source text for whole-token utility candidates; a
utility written flush against `${...}` (`` `[scrollbar-gutter:stable]${x ? ' y' : ''}` ``)
isn't a token it recognizes, so it silently emits no CSS — and this survives
typecheck, tests, and build without a single warning.
Rule: always leave a space between a static utility and an interpolation.
Never build a class name by string concatenation Tailwind can't statically
see; switch between whole utility strings instead. Only a grep of the *built*
stylesheet catches this — the source looks correct either way.

### 12. A design system's own token names can collide with Tailwind's utility scale
Problem: if your unlayered stylesheet declares a custom property under the same
name a Tailwind utility reads from (`--radius-sm`, `--text-base`, `--font-sans`,
any `--<namespace>-<step>`), your value wins unconditionally — every consumer
of that utility silently renders your value instead of Tailwind's documented
one, and every line of source using it looks completely correct.
Rule: before relying on any Tailwind utility whose value flows from a
`--<namespace>-<step>`-shaped token, check whether your own stylesheet declares
that exact name. If it does, rename your token to a distinguishing prefix
rather than trying to redefine Tailwind's scale — a shared name is a landmine
for the next drive-by user of that utility, not just for the migration.

### 13. Verify a shared-primitive conversion by pixel diff, not by reading computed styles
Problem: two functionally-identical states can produce a dozen benign string
differences in computed style (e.g. `border-style: none` making a color
difference moot, or v4 splitting `transform: matrix(...)` into separate
`scale`/`translate`/`rotate` properties) — each one costs an argument to
dismiss, and a real regression can hide among them.
Rule: build a harness that renders the pre-conversion markup (with its deleted
CSS rules re-injected into the *same layer* they came from) beside the
post-conversion markup, and diff bitmaps, not computed-style strings. Call
`DOM.getDocument` exactly once per harness session (a second call discards
forced pseudo-states already set), and settle past any CSS transitions before
snapshotting, or you'll measure two points on the same easing curve as a
color mismatch.

### 14. A generic one-word class can be styled globally, far from the family you're converting
Problem: a state-token class (`.empty`, `.on`, `.active`) can have a bare,
unlayered, globally-scoped rule declared nowhere near the family being
converted — invisible to a per-surface census, to an orphan grep (it isn't
being deleted), and to an ancestor-coupling grep (there's no local rule to
start from).
Rule: for any class in the converted markup that reads like a generic state
token rather than a family-specific name, grep the *whole* stylesheet for it
as a bare selector, regardless of how far from the family it lives.

### 15. A multi-property Tailwind utility is a hazard in a fidelity conversion
Problem: some utilities (`text-sm`, `text-2xl`, ...) set more than the one
property their name suggests — `text-*` sets `line-height` alongside
`font-size`. Converting a source rule that set only `font-size` therefore adds
a `line-height` the original never had, and the error compounds visually down
the whole page as every element below shifts.
Rule: know which utilities in your framework are multi-property, and for a
`font-size`-only source rule use the arbitrary-value form
(`text-[13px]`) which sets only what the rule set. Don't reach for a
"restore the other half" utility (`leading-normal`) without checking that its
value actually equals what "unset" meant before — a named step and a bare
absence are often different values.

### 16. Equal-specificity utility ties are decided by Tailwind's EMISSION order, not by class-string order
Problem: every utility has the same specificity, so when two utilities on one
element set the same property, the tie is broken by their order in the
*generated* stylesheet — which has nothing to do with the order they appear in
your `className`, and reordering the string changes nothing.
Rule: when a base utility and a conditional override target the same property
(especially two arbitrary values wrapping functions like `var()`/`color-mix()`,
which don't read like members of a scale you'd think to check), verify which
one wins by checking byte offset in the built sheet, not by re-arranging
source text.

### 17. The unlayered rule your declaration used to beat may be a `*` selector
Problem: rule 1's "unlayered beats layered" means the rule a converted
declaration used to safely override can be a universal selector thousands of
lines away with nothing in its name connecting it to the family under
conversion (e.g. a global `* { scrollbar-width: thin }` that a component
rule used to locally override).
Rule: before converting a rule that overrides a broad/universal selector,
confirm what would win once your override moves into `@layer utilities` —
every remaining unlayered rule, including `*`, now outranks it regardless of
specificity.

### 18. An arbitrary `text-[var(--x)]` value is read as a COLOR unless hinted
Problem: Tailwind can't tell whether a bare `var()` inside `text-[...]` is a
color or a length, and resolves the ambiguity to color — so porting a
`font-size: var(--token)` rule as `text-[var(--token)]` silently sets `color`
instead, and the element falls back to its inherited font size.
Rule: use the `length:` type hint — `text-[length:var(--token)]` — for any
arbitrary `text-*` value that's meant to be a size. Confirm the property in
the built sheet; the source looks identical either way.

### 19. Word-boundary grep for orphans; jsdom sees no CSS; coverage vs. mounted
Three standing verification traps, restated together because they compound:
- **A difference that appears only in a full harness run and never in
  isolation is evidence about the harness, not the code** — chase the
  instrument, not the conversion, when isolating a flagged element shows
  nothing.
- **Agreement is only evidence when both sides are proven isolated.** Every
  harness bug so far failed toward reporting "0 differences" — a scoping bug
  that leaks old rules onto the new side, or a comment that silently truncates
  a stylesheet, both look like a clean pass. Every harness run needs a
  positive control: inject an unmissable marker, confirm the run flags exactly
  the cases that should carry it and none of the others, then remove it and
  measure for real.
- **"Selectors covered" is not "elements mounted."** A private/unexported
  component with no route in your test harness can be enumerated in a
  selector census while being structurally unreachable — grep coverage lies
  about integration coverage.

### 20. Forcing a pseudo-state on one node synthesizes states the browser can't produce
Problem: `:hover`/`:active` apply to an element *and every ancestor it sits
inside*; forcing the pseudo-class via CDP on a single leaf node models a state
no real pointer interaction can produce (descendant hovered, ancestor not),
which can make an ancestor-coupled rule that never actually renders look like
a live regression when the leaf-forced comparison disagrees with it.
Rule: force `:hover`/`:active` on the whole ancestor chain of an interactive
element, not just the leaf; `:focus-visible` stays single-element, since focus
genuinely doesn't propagate to ancestors that way.

### 21. A class kept literal "for a surviving out-of-shard rule" is a CLAIM — assert it
Problem: dropping a class removes it from *both* the old and new sides of a
diff-based harness at once, so the surviving rule stops matching on both sides
simultaneously — the diff reads 0, the suite stays green, and the actual
behavior is silently gone. No bitmap or computed-style diff can see this,
because both sides are equally wrong.
Rule: for any class kept in markup solely because an out-of-shard rule
depends on it, add an explicit per-case assertion of what must be TRUE after
the change (e.g. "this selector must resolve to this computed value"),
resolved independently on each side. A selector matching zero elements must
fail loudly, never pass vacuously.

### 22. An invariant nobody wired to a test case is indistinguishable from one that passed
Problem: an assertion engine can exist, be correct, and be documented in the
very CSS comment describing the invariant it's supposed to protect — and never
actually run, because the test case it's meant to gate carries zero
assertions. The output ("0 failing") is the exact shape of a passing check and
means the opposite.
Rule: a zero result is only evidence once you've shown the same mechanism
*can* produce a non-zero. Before trusting a green invariant check, verify it
is wired to a real case that would fail if the invariant were violated.

### 23. A class can be both a style hook and a query hook — converting one breaks the other
Problem: test/harness tooling often locates elements by the same class name
the stylesheet uses for styling. Converting that class to a Tailwind utility
(or a class-string constant) removes the query anchor along with the style
rule, breaking the *instrument* on both sides at once rather than causing a
visible new-side regression.
Rule: grep test/harness selector code (`query:`, `sel:`, `.className` string
literals) for a class before converting it, not after. Give the element a
durable, purpose-built hook (an `aria-label`, a `data-testid`) instead of
depending on a style class surviving as an addressing scheme.

### 24. Converting a rule can INVERT a cascade a layer used to settle
Problem: the whole safety argument for "utilities beat the legacy layer" stops
applying the moment BOTH competing declarations move into `@layer utilities` —
the layer tiebreak disappears, specificity decides instead, and specificity
can point the opposite way from what the old layer-based cascade produced
(e.g. inside `@layer utilities`, a `hover:` variant's (0,2,0) beats a bare
arbitrary property's (0,1,0), reversing which one used to win).
Rule: when converting two co-located rules that used to be decided by one
being layered and the other not, re-derive their relative specificity as
plain utilities before assuming the old winner still wins — read the built
sheet, don't infer from the old layer relationship. Use `!important`
deliberately on whichever declaration must keep winning if specificity now
disagrees with the old outcome.

### 25. A fixed settle/wait time cannot be sized against load it cannot see
Problem: a fixed delay (e.g. "wait 60ms for the DOM to update before asserting")
measured on a warm, idle harness can be 10-15x longer than the real median and
still fail ~1 run in 3 once run under real contention (screenshots and CDP
round-trips competing for the same thread) — because the distribution that
matters is the one under load, which no amount of isolated probing can
discover.
Rule: when a flake traces to a fixed wait, don't re-tune the constant — poll
for the actual condition instead. Grep for a comment that already diagnoses
the identical mechanism elsewhere in the harness before re-deriving it from
scratch.
