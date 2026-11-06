"""Inline all sources (src/) into one self-contained index.html (the published app)."""
import re, pathlib
root = pathlib.Path(__file__).parent
src = root / 'src'
html = (src / 'index.html').read_text(encoding='utf-8')
def inline(m):
    name = m.group(1)
    text = (src / name).read_text(encoding='utf-8')
    assert '</script' not in text.lower(), f'{name} contains a closing script tag'
    return text
out = re.sub(r'/\*INLINE:([\w.]+)\*/', inline, html)
(root / 'index.html').write_text(out, encoding='utf-8')
print('index.html', round(len(out.encode('utf-8')) / 1024, 1), 'KB')
