#!/usr/bin/env bash

# Holds the comment budget: a block is at most three lines, and names no date,
# plan number, other app or person. Only comment text is scanned -- a date in a
# string literal or a fixture does not trip it.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [ "$#" -gt 0 ]; then
  files=("$@")
else
  mapfile -t files < <(git ls-files -co --exclude-standard \
    'core/*.rs' 'src-tauri/*.rs' 'ui/src/*.ts' 'ui/src/*.tsx' 'ui/src/*.css' \
    'ui/src/*.html' 'ui/p5-harness/*.mjs' 'scripts/*.sh' 'scripts/*.ps1' \
    '.github/*.yml' \
    | grep -vE '/generated/|/node_modules/|/ghostty/vendor/')
fi

[ "${#files[@]}" -gt 0 ] || exit 0

perl - "${files[@]}" <<'PERL'
use strict; use warnings;

# The budget, not a taste test: three lines is what fits an invariant, a trap
# or a reason. Anything longer is a document -- write it in docs/ and link it.
my $MAX_BLOCK = 3;

# Each rule: name => [regex over the comment text, what to write instead].
my @rules = (
  [ 'date',    qr/\b20\d\d-\d\d-\d\d\b/,
    'no dates in comments; git blame has them' ],
  [ 'phase',   qr/(?:\b(?:phase|wave|charter|batch|round)\s*\d|\bstep\s+\d+[a-z]?\b|\bitem\s+\d+\b|§)/i,
    'no plan/phase/step numbering; describe the behaviour, not the roadmap' ],
  [ 'product', qr/\b(?:bridgemind|bridge-mind|bm1|t3 ?code|orca|herdr|overclock)\b/i,
    'no other app names; keep the value, drop the provenance' ],
  [ 'person',  qr/\bTheo\b/i,
    'no person in a comment; state the rule the code keeps' ],
);

my %hits; my $total = 0; my $shown = 0; my $CAP = 60;

sub report {
  my ($file, $line, $rule, $text) = @_;
  $hits{$rule}++; $total++;
  $text =~ s/^\s+|\s+$//g;
  $text = substr($text, 0, 110) . '…' if length($text) > 110;
  print "$file:$line: [$rule] $text\n" if $shown++ < $CAP;
}

for my $file (@ARGV) {
  next unless -f $file;
  open my $fh, '<', $file or next;
  my @lines = <$fh>; close $fh;
  my $ext = ($file =~ /\.(\w+)$/) ? $1 : '';
  my $in_block = 0;
  my $run = 0; my $run_start = 0;

  my $flush = sub {
    my ($end) = @_;
    if ($run > $MAX_BLOCK) {
      $hits{'budget'}++; $total++;
      print "$file:$run_start: [budget] $run consecutive comment lines (cap $MAX_BLOCK); say it shorter, or write it in docs/ and link\n" if $shown++ < $CAP;
    }
    $run = 0;
  };

  for my $i (0 .. $#lines) {
    my $raw = $lines[$i]; my $n = $i + 1;
    my $comment;

    my $own_line = 0;
    if ($ext eq 'sh' || $ext eq 'yml' || $ext eq 'ps1') {
      if ($raw =~ /^\s*#(?!!)(.*)$/) { $comment = $1; $own_line = 1; }
      $comment = $1 if !defined $comment && $raw =~ /\s#\s(.*)$/;
    } elsif ($ext eq 'css' || $ext eq 'html') {
      if ($in_block) { $comment = $raw; $own_line = 1; $in_block = 0 if $raw =~ /\*\/|-->/; }
      elsif ($raw =~ /(\/\*|<!--)(.*)$/) { $comment = $2; $own_line = 1; $in_block = 1 unless $raw =~ /\*\/|-->/; }
    } else {  # rs, ts, tsx, mjs
      if ($in_block) { $comment = $raw; $own_line = 1; $in_block = 0 if $raw =~ /\*\//; }
      elsif ($raw =~ /^\s*\/\*(.*)$/) { $comment = $1; $own_line = 1; $in_block = 1 unless $raw =~ /\*\//; }
      elsif ($raw =~ /^\s*(\/\/[\/!]?)(.*)$/) { $comment = $2; $own_line = 1; }
      elsif ($raw =~ /^(?:[^"'`]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)*?\/\/(.*)$/) { $comment = $1; }
    }

    if (defined $comment) {
      if ($own_line) {
        $run_start = $n if $run == 0;
        $run++;
      } else {
        $flush->($n - 1) if $run;
      }
      for my $r (@rules) {
        my ($name, $re) = @$r;
        next unless $comment =~ $re;
        report($file, $n, $name, $comment);
      }
    } else {
      $flush->($n - 1) if $run;
    }
  }
  $flush->(scalar @lines) if $run;
}

if ($total) {
  print "… and " . ($total - $CAP) . " more\n" if $total > $CAP;
  print "\ncheck-comment-hygiene: $total hit(s):\n";
  for my $r (@rules, ['budget']) {
    my $name = $r->[0];
    next unless $hits{$name};
    my $fix = $name eq 'budget' ? "comment blocks over $MAX_BLOCK lines" : $r->[2];
    printf "  %-8s %5d  %s\n", $name, $hits{$name}, $fix;
  }
  exit 1;
}
print "check-comment-hygiene: ok\n";
PERL
