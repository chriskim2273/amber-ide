#!/usr/bin/env python3
"""Identify which Pi conversation each shell pane was displaying when the daemon
was killed.

The daemon restores a pane's scrollback ring before the replacement shell writes
its first prompt, so the text immediately before that prompt is the pane's last
rendered screen — which, for a pane that had Pi running, is Pi's TUI frame for
the conversation that was open. Pi rewrites only changed regions after startup,
so a pane's ring holds the last screen(s), not the whole transcript; matching
therefore works from the pane's screen text towards the conversations, using
short n-grams (Pi pads and wraps lines, so only short runs survive intact).
"""
import glob, json, os, re, sys
from pathlib import Path

S = Path('/home/poyto/.local/state/amber-ide')
SESS = Path(os.path.expanduser('~/.pi/agent/sessions'))
CSI = re.compile(rb'\x1b\[[0-9;?]*[ -/]*[@-~]')
OSC = re.compile(rb'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)')
PROMPT = re.compile(r'poyto@teapot-dev:[^\n$]*\$')
DASHES = {'\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-'}
QUOTES = {'\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"', '\u2026': '...'}

def normalize(text: str) -> str:
    for k, v in {**DASHES, **QUOTES}.items():
        text = text.replace(k, v)
    return re.sub(r'\s+', ' ', text)

def ring_screen(pane: str) -> str:
    raw = (S / 'scrollback' / f'{pane}.bin').read_bytes()
    raw = OSC.sub(b'', raw)
    raw = CSI.sub(b'', raw)
    text = raw.replace(b'\r\n', b'\n').replace(b'\r', b'\n').decode('utf-8', 'replace')
    text = normalize(text)
    # Everything before the last shell prompt is the pre-restart screen; the
    # prompt itself and what follows are the replacement shell the daemon spawned.
    matches = list(PROMPT.finditer(text))
    return text[:matches[-1].start()] if matches else text

def ngrams(screen: str, n: int = 6, limit: int = 400):
    words = [w for w in re.findall(r"[A-Za-z0-9_/.'-]{3,}", screen)]
    out, seen = [], set()
    for i in range(len(words) - n):
        gram = ' '.join(words[i:i + n])
        if gram not in seen:
            seen.add(gram)
            out.append(gram)
    return out[-limit:] if len(out) > limit else out

def tail_text(path: Path, max_bytes: int = 400_000) -> str:
    size = path.stat().st_size
    with path.open(errors='replace') as fh:
        if size > max_bytes:
            fh.seek(size - max_bytes)
            fh.readline()
        return normalize(fh.read())

def rank(pane: str):
    meta = json.loads((S / 'sessions' / f'{pane}.json').read_text())
    screen = ring_screen(pane)
    grams = ngrams(screen)
    dir_name = '--' + meta['cwd'].lstrip('/').replace('/', '-') + '--'
    rows = []
    for conv in sorted(SESS.glob(f'{dir_name}/*.jsonl')):
        try:
            body = tail_text(conv)
        except OSError:
            continue
        hits = [g for g in grams if g in body]
        rows.append({'conversation': str(conv), 'score': len(hits),
                     'grams': len(grams), 'mtime': os.path.getmtime(conv),
                     'size': conv.stat().st_size, 'sample': hits[:2]})
    rows.sort(key=lambda r: -r['score'])
    return meta, screen, rows

if __name__ == '__main__':
    out = {}
    for pane in sys.argv[1:]:
        meta, screen, rows = rank(pane)
        import datetime
        print(f"\n=== {pane}  title={meta.get('title')}  cwd={meta['cwd']}")
        print(f"    screen text kept: {len(screen)} chars")
        neg = [r for r in rows if r['score'] == 0]
        print(f"    conversations with zero match: {len(neg)}/{len(rows)}")
        for r in rows[:4]:
            when = datetime.datetime.fromtimestamp(r['mtime']).strftime('%m-%d %H:%M')
            print(f"    score={r['score']:3}  {when}  {r['size']//1024:>6} KiB  {Path(r['conversation']).name[:50]}")
            for s in r['sample']:
                print(f"           e.g. {s[:88]}")
        out[pane] = {'cwd': meta['cwd'], 'title': meta.get('title'),
                     'screen_chars': len(screen), 'candidates': rows[:4]}
    (Path(__file__).parent / 'matching-ngram.json').write_text(json.dumps(out, indent=2))
