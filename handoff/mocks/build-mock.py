#!/usr/bin/env python3
"""Splice mocks/fragments/*.html into the base mock. Usage: build-mock.py [--only slug] [--out path]"""
import glob, os, re, sys
D = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
out = os.path.join(D, 'houston-mocks.html'); only = None
if '--out' in args: out = args[args.index('--out') + 1]
if '--only' in args: only = args[args.index('--only') + 1]
base = open(os.path.join(D, 'houston-mocks.base.html')).read()
parts = {'style': [], 'views': [], 'script': []}
for f in sorted(glob.glob(os.path.join(D, 'fragments', '*.html'))):
    slug = os.path.basename(f)[:-5]
    if only and slug != only: continue
    src = open(f).read()
    for key in parts:
        m = re.search(r'<!-- @%s -->(.*?)(?=<!-- @(?:style|views|script) -->|\Z)' % key, src, re.S)
        if m: parts[key].append(f'/* {slug} */\n' + m.group(1).strip() if key != 'views' else f'<!-- {slug} -->\n' + m.group(1).strip())
for key, marker in (('style', '/* @fragments:style */'), ('views', '<!-- @fragments:views -->'), ('script', '// @fragments:script')):
    base = base.replace(marker, marker + '\n' + '\n'.join(parts[key]), 1)
open(out, 'w').write(base)
print(f'wrote {out}: ' + ', '.join(f'{k}={len(v)}' for k, v in parts.items()))
