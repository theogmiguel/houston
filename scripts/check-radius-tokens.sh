#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [ -n "${SCAN_ROOT:-}" ]; then
  scan_roots=("$SCAN_ROOT")
else
  scan_roots=(ui/src/renderer/src/components/ui ui/src/renderer/src/theme.css ui/src/renderer/src/tailwind.css ui/src/renderer/src/keyframes.css ui/src/renderer/src/base.css)
fi
tailwind_css="ui/src/renderer/src/tailwind.css"
fail=0


mapped_steps="$(perl -e '
  my $f = shift;
  open my $fh, "<", $f or exit 0;
  local $/ = undef;
  my $src = <$fh>;
  close $fh;
  # The @theme block, brace-matched shallowly: it holds only declarations.
  while ($src =~ /\@theme\s*\{(.*?)\n\}/sg) {
    my $body = $1;
    while ($body =~ /--radius-([a-z0-9]+)\s*:\s*([^;]*);/g) {
      # Copied out before the value is matched: a bare `$2 =~ //` in an `if`
      # modifier runs first and clears $1 with its own (group-less) capture.
      my ($step, $value) = ($1, $2);
      print "$step\n" if $value =~ /--tr-radius-/;
    }
  }
' "$tailwind_css" | sort -u | tr '\n' ' ')"

banned_steps=()
for step in xs sm md lg xl 2xl 3xl 4xl; do
  case " $mapped_steps " in *" $step "*) ;; *) banned_steps+=("$step") ;; esac
done
banned_alt="$(IFS='|'; echo "${banned_steps[*]}")"

mapfile -t sources < <(find "${scan_roots[@]}" -type f \
  | grep -E '\.(ts|tsx|css)$' \
  | grep -v '\.test\.tsx\?$' \
  | sort -u)

counts="$(BANNED="$banned_alt" perl -e '
  my $banned = $ENV{BANNED};
  # rule 1 -- a numeric arbitrary value on `rounded` or any corner variant.
  # `[0-9.]` right after the bracket is what separates it from var()/calc()/
  # inherit/50%.
  my $LIT = qr/\brounded(?:-[a-z]{1,2})?-\[[0-9][0-9.]*(?:px|rem|em|pt)\]/;
  # rule 2 -- a framework step, as a whole word so `rounded-md-thing` and a
  # `--radius-md` declaration do not match. Empty when every step is mapped.
  my $UTIL = length($banned)
    ? qr/(?<![\w-])rounded-(?:$banned)(?![\w-])/
    : undef;
  # rule 3 -- a hand-typed length in a stylesheet. `0`, var(), calc() and
  # inherit all fail the leading `[1-9]|0\.` test.
  my $CSS = qr/border-radius\s*:[^;]*?(?<![\w.-])[0-9][0-9.]*(?:px|rem|em|pt|%)/;
  for my $f (@ARGV) {
    open my $fh, "<", $f or next;
    local $/ = undef;
    my $src = <$fh>;
    close $fh;
    # Comments are stripped first: this house writes `rounded-md` in prose to
    # explain why it is not used, and a doc comment is not a call site. `//`
    # only outside .css, where it is not a comment.
    $src =~ s{/\*.*?\*/}{}gs;
    $src =~ s{//.*}{}g unless $f =~ /\.css$/;
    my (%hit, %val);
    while ($src =~ /$LIT/g) { $hit{pos($src)} = $&; $val{$&} = 1; }
    while ($src =~ /\[border-radius\s*:\s*([0-9][0-9.]*(?:px|rem|em|pt|%))[^\]]*\]/g) {
      $hit{pos($src)} = $&; $val{$&} = 1;
    }
    if (defined $UTIL) {
      while ($src =~ /$UTIL/g) { $hit{pos($src)} = $&; $val{$&} = 1; }
    }
    if ($f =~ /\.css$/ && $f !~ m{/(?:theme|tailwind)\.css$}) {
      while ($src =~ /$CSS/g) { my $m = $&; $m =~ s/\s+/ /g; $hit{pos($src)} = $m; $val{$m} = 1; }
    }
    my $n = scalar keys %hit;
    next unless $n > 0;
    my @v = sort keys %val;
    @v = (@v[0..3], "…") if @v > 5;
    my @where;
    for my $offset (sort {$a <=> $b} keys %hit) {
      my $line = 1 + (substr($src, 0, $offset) =~ tr/\n//);
      push @where, "$line:$hit{$offset}";
    }
    print "$n\t$f\t" . join(", ", @v) . "\t" . join(";", @where) . "\n";
  }
' "${sources[@]}")"

widened_report="$(perl -e '
  for my $f (@ARGV) {
    open my $fh, "<", $f or next;
    local $/ = undef;
    my $src = <$fh>;
    close $fh;
    $src =~ s{/\*.*?\*/}{}gs;
    $src =~ s{//.*}{}g unless $f =~ /\.css$/;
    while ($src =~ /\[border-radius\s*:\s*([0-9][0-9.]*(?:px|rem|em|pt|%))[^\]]*\]/g) {
      my $line = 1 + (substr($src, 0, pos($src)) =~ tr/\n//);
      print "$f\t$line\t$&\n";
    }
  }
' "${sources[@]}")"

fail=0
while IFS=$'\t' read -r file line value; do
  [ -n "$file" ] || continue
  echo "FAIL: radius-token $file:$line '$value'; expected rounded-[var(--tr-radius-<rung>)] or border-radius: var(--tr-radius-<rung>)" >&2
  fail=1
done <<< "$widened_report"
while IFS=$'\t' read -r n file values locations; do
  [ -n "$file" ] || continue
  echo "FAIL: radius-token $file:$locations '$values'; expected rounded-[var(--tr-radius-<rung>)] or border-radius: var(--tr-radius-<rung>)" >&2
  fail=1
done <<< "$counts"
[ "$fail" -eq 0 ] && echo "ok: radius-token passes (unmapped Tailwind steps: ${banned_alt//|/,})"
exit "$fail"
