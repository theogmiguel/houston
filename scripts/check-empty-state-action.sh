#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT=ui/src/renderer/src
EXEMPT='chat-question|settings-detail-empty-set|appearance-picker-empty-set'

mapfile -t FILES < <(find "$ROOT" -name '*.tsx' ! -name '*.test.tsx' | sort)

fails=0
checked=0
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  file=${hit%%:*}; rest=${hit#*:}; line=${rest%%:*}
  checked=$((checked + 1))
  block=$(sed -n "${line},$((line + 40))p" "$file")
  joined=$(printf '%s' "$block" | tr '\n' ' ')
  has_control=$(printf '%s' "$block" | grep -cE '<button|<a |<EmptyState' || true)
  imp_out=$(printf '%s' "$joined" | perl -ne '
    my $verbs = qr/(?:add|start|create|pick|choose|click|open|connect|install|enable|select|run)/i;
    my @m;
    while (/>[^<]*?(?<!cannot )(?<!can.t )(?<!won.t )(?<!unable to )(?<!will not )\b($verbs)\s[a-z][^<]*/g) {
      push @m, $&;
    }
    print scalar(@m), "\n";
    print "$_\n" for @m[0 .. ($#m > 1 ? 1 : $#m)];
  ')
  imperative=$(printf '%s' "$imp_out" | head -1)
  if [ "$has_control" -eq 0 ] && [ "$imperative" -gt 0 ]; then
    echo "FAIL $file:$line -- copy names an action, no control in the subtree"
    printf '%s' "$imp_out" | tail -n +2 | sed 's/^/       /'
    fails=$((fails + 1))
  fi
done < <(grep -rnE '(data-testid|testId)="[^"]*(empty|no-matches|not-|unselected)[^"]*"' "${FILES[@]}" \
         | grep -vE "$EXEMPT" || true)

if [ "$fails" -gt 0 ]; then
  echo
  echo "check-empty-state-action: $fails empty state(s) name an action they do not offer."
  echo "Put the control under the sentence, or reword the copy to state a fact."
  exit 1
fi

echo "ok check-empty-state-action ($checked empty state(s) checked, $(echo "$EXEMPT" | tr '|' '\n' | wc -l) exemption pattern(s))"
