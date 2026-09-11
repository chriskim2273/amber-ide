#!/usr/bin/env python3
"""Rank candidate Pi conversations for each named pane by matching the pane's
raw ring content against each conversation's own transcript.

A pane that had Pi on screen when the daemon was killed still holds that Pi
session's rendered text in its scrollback ring (the daemon restores the ring
before the new shell writes its prompt). Pi writes assistant text without the
box borders it uses for user prompts, so assistant text survives whitespace
normalisation; user prompts are wrapped in borders and are not used.
"""
import glob, json, os, re, sys
from pathlib import Path

S = Path('/home/poyto/.local/state/amber-ide')
SESS = Path(os.path.expanduser('~/.pi/agent/sessions'))
CSI = re.compile(rb'\x1b\[[0-9;?]*[ -/]*[@-~]')
OSC = re.compile(rb'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)')

BOX = re.compile(r'[\u2500-\u257f\u2580-\u259f]')

def plain(raw: bytes) -> str:
    raw = OSC.sub(b'', raw)
    raw = CSI.sub(b'', raw)
    text = raw.replace(b'\r\n', b'\n').replace(b'\r', b'\n').decode('utf-8', 'replace')
    # Pi draws user prompts and reasoning inside box borders; a wrapped prompt is
    # split by the border characters, which would break every substring match.
    # Dropping the box-drawing block keeps the wrapped text contiguous.
    text = BOX.sub(' ', text)
    return re.sub(r'\s+', ' ', text)

def probes(path: Path, n=24):
    texts = []
    for line in path.open(errors='replace'):
        try:
            d = json.loads(line)
        except Exception:
            continue
        msg = d.get('message') or {}
        if msg.get('role') not in ('assistant', 'user'):
            continue
        c = msg.get('content')
        if not isinstance(c, list):
            continue
        t = ' '.join(b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text')
        t = re.sub(r'\s+', ' ', t).strip()
        # Skip harness-injected blocks; only keep text the user or model wrote.
        if len(t) > 60 and not t.startswith('<') and 'toolResult' not in t[:24]:
            texts.append(t)
    if not texts:
        return []
    if len(texts) <= n:
        return texts
    step = len(texts) / n
    return [texts[int(i * step)] for i in range(n)]

def enc(cwd: str) -> str:
    return '--' + cwd.lstrip('/').replace('/', '-') + '--'

def rank(pane: str):
    meta = json.loads((S / 'sessions' / f'{pane}.json').read_text())
    raw = (S / 'scrollback' / f'{pane}.bin').read_bytes()
    text = plain(raw)
    convs = [p for p in SESS.glob(f'{enc(meta["cwd"])}/*.jsonl')]
    rows = []
    for conv in convs:
        ps = probes(conv)
        if not ps:
            continue
        hits = [p for p in ps if p[:45] in text]
        if not hits:
            continue
        last = max(text.rfind(p[:45]) for p in hits)
        rows.append({'conversation': str(conv), 'hits': len(hits), 'probes': len(ps),
                     'last_pos_pct': round(100 * last / max(1, len(text))),
                     'mtime': os.path.getmtime(conv), 'size': conv.stat().st_size})
    rows.sort(key=lambda r: (-r['hits'], -r['last_pos_pct']))
    return meta, rows

if __name__ == '__main__':
    out = {}
    for pane in sys.argv[1:]:
        meta, rows = rank(pane)
        out[pane] = {'cwd': meta['cwd'], 'title': meta.get('title'), 'candidates': rows[:5]}
        print(f"\n=== {pane}   title={meta.get('title')}   cwd={meta['cwd']}")
        if not rows:
            print('    no conversation text found in this pane\'s ring')
        for r in rows[:5]:
            import datetime
            when = datetime.datetime.fromtimestamp(r['mtime']).strftime('%m-%d %H:%M')
            print(f"    hits={r['hits']:2}/{r['probes']:2} last@{r['last_pos_pct']:3}%  {when}  "
                  f"{r['size']//1024:>6} KiB  {Path(r['conversation']).name[:52]}")
    (Path(__file__).parent / 'matching.json').write_text(json.dumps(out, indent=2))
