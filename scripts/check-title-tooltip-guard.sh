#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

ui_src="ui/src"
fail=0

COMPONENT_PROPS=(Row SettingsRow GoalProgressRow DetailCard LinkPanel RenameTitle SettingsDetail NavSurface Centered SectionHead NavDetailState NavEmpty HeadlessRoleRow)

COMPONENT_PROPS_OPTIONAL=(ConfirmModal)

NATIVE_ELEMENT_ALIASES=(Tag)

mapfile -t all_tsx < <(find "$ui_src" -type f -name '*.tsx' \
  -not -path '*/node_modules/*' -not -path '*/dist/*')

report="$(COMPONENT_PROPS_LIST="${COMPONENT_PROPS[*]}" \
  COMPONENT_PROPS_OPTIONAL_LIST="${COMPONENT_PROPS_OPTIONAL[*]}" \
  NATIVE_ALIAS_LIST="${NATIVE_ELEMENT_ALIASES[*]}" perl -e '
  my %known = map { $_ => 1 } split " ", $ENV{COMPONENT_PROPS_LIST};
  my %optional = map { $_ => 1 } split " ", $ENV{COMPONENT_PROPS_OPTIONAL_LIST};
  my @aliases = split " ", $ENV{NATIVE_ALIAS_LIST};
  for my $f (@ARGV) {
    open my $fh, "<", $f or next;
    local $/ = undef;
    my $src = <$fh>;
    close $fh;
    # Which aliases this file has EARNED: the name must be assigned a native
    # element string here. A real component named Tag gets no exemption.
    my %native = map { $_ => 1 }
      # \x27 is a literal quote: the perl program sits in a single-quoted
      # shell string. The quotes matter — without them a bare
      # `const Tag = SomeButtonWidget` would earn the exemption.
      grep { $src =~ /\bconst\s+\Q$_\E\s*=[^\n]*\x27(?:button|div|span|section|label)\x27/ }
      @aliases;
    # Native lowercase elements carrying `title=` — the browser tooltip this
    # guard exists to replace. Fixtures are skipped here only. The lookbehind
    # keeps `DataTableColumn<Row>[]` from reading as an untitled `<Row>`.
    if ($f !~ /\.test\.tsx?$/) {
      my $native_n = 0;
      while ($src =~ /(?<![A-Za-z0-9_])<([a-z][a-zA-Z0-9-]*)\b(.*?)(?:\/>|>)/sg) {
        my $attrs = $2;
        next unless $attrs =~ /(?:^|[\s{])title\s*=/s;
        $native_n++;
      }
      print "NATIVECOUNT:$f:$native_n\n" if $native_n > 0;
    }
    while ($src =~ /(?<![A-Za-z0-9_])<([A-Z][A-Za-z0-9]*)\b(.*?)(?:\/>|>)/sg) {
      my ($tag, $attrs) = ($1, $2);
      my $pos = pos($src) - length($&);
      my $line = 1 + (substr($src, 0, $pos) =~ tr/\n//);
      my $has_title = ($attrs =~ /(?:^|[\s{])title\s*=/s) ? 1 : 0;
      if ($native{$tag}) {
        # a native element behind a capitalised alias -- title= is the plain
        # HTML attribute, not a component prop; neither check applies
      } elsif ($optional{$tag}) {
        # reviewed, and its title has a default -- neither check applies
      } elsif ($known{$tag}) {
        print "MISSING:$f:$line:$tag\n" unless $has_title;
      } else {
        print "UNREVIEWED:$f:$line:$tag\n" if $has_title;
      }
    }
  }
' "${all_tsx[@]}")"

native_counts="$(grep '^NATIVECOUNT:' <<< "$report" | sed 's/^NATIVECOUNT://' | sort -t: -k1,1 \
  | while IFS=: read -r f n; do printf '%s\t%s\n' "$n" "$f"; done || true)"

if [ "${1:-}" = "--baseline" ]; then
  if [ -z "$native_counts" ]; then
    echo "ok: nothing to pin, the guard has no exceptions"
  else
    echo "$native_counts"
  fi
  exit 0
fi

missing="$(grep '^MISSING:' <<< "$report" || true)"
if [ -n "$missing" ]; then
  while IFS=: read -r _ f line tag; do
    echo "FAIL: $f:$line -- <$tag> call site with no title= (required prop)" >&2
  done <<< "$missing"
  fail=1
else
  echo "ok: every known component-prop title= call site (${COMPONENT_PROPS[*]}) is intact"
fi

unreviewed="$(grep '^UNREVIEWED:' <<< "$report" || true)"
if [ -n "$unreviewed" ]; then
  while IFS=: read -r _ f line tag; do
    echo "FAIL: $f:$line -- unreviewed component prop <$tag title=…> (not in COMPONENT_PROPS)" >&2
  done <<< "$unreviewed"
  echo "      Open the component's definition, see what it does with title," >&2
  echo "      then either add it to COMPONENT_PROPS in this script (if it" >&2
  echo "      renders title as visible UI) or leave it (if it's a plain" >&2
  echo "      passthrough to a native title=)." >&2
  fail=1
else
  echo "ok: no unreviewed capitalised-component title= usage found"
fi

if [ -n "$native_counts" ]; then
  echo "FAIL: native title= found (none are allowed):" >&2
  while IFS=$'\t' read -r n f; do
    [ -n "$f" ] && echo "  $f -- $n native title=" >&2
  done <<< "$native_counts"
  echo "      A hover label is <Tooltip label=…>, never a native title=." >&2
  echo "      STYLEGUIDE, 'Tooltip vs title'." >&2
  fail=1
else
  echo "ok: no native title= found -- the guard has no exceptions"
fi

exit "$fail"
