"""Bangun aset merek TTOken Code untuk installer dan layar sambutan desktop."""
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

font_path, out = sys.argv[1], sys.argv[2]

def outline(text, weight, size, tracking):
    """Kembalikan (path_d, lebar) untuk teks pada ukuran font tertentu, baseline di y=0."""
    font = TTFont(font_path)
    axes = {a.axisTag: a.defaultValue for a in font['fvar'].axes}
    axes['wght'] = weight
    if 'opsz' in axes: axes['opsz'] = 48
    font = instantiateVariableFont(font, axes)
    glyphs, cmap, upm = font.getGlyphSet(), font.getBestCmap(), font['head'].unitsPerEm
    scale, x, parts = size / upm, 0.0, []
    for ch in text:
        name = cmap[ord(ch)]
        pen = SVGPathPen(glyphs, ntos=lambda v: f'{v:.2f}'.rstrip('0').rstrip('.'))
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, 0)))
        d = pen.getCommands()
        if d: parts.append(d)
        x += glyphs[name].width * scale + tracking * size
    return ' '.join(parts), x - tracking * size

INK, PAPER, KUNYIT, CREAM = '#0C0B09', '#F4EFE4', '#FFB21A', '#F4EFE4'

def mark(bar):
    return (f'<g fill="{KUNYIT}"><rect x="4" y="8" width="56" height="16" rx="8"/><rect x="10" y="12" width="18" height="44" rx="9"/>'
            f'<rect x="36" y="12" width="18" height="26" rx="9"/></g><rect x="36" y="45" width="18" height="8" rx="4" fill="{bar}"/>')

def app_icon(x, y, s):
    k = s / 512
    return (f'<g transform="translate({x} {y}) scale({k})"><rect width="512" height="512" rx="112" fill="{INK}"/>'
            f'<g transform="translate(96 96) scale(5)">{mark(CREAM)}</g></g>')

# Wordmark mengikuti web: "TTOken" tebal, nama produk lebih ringan.
def wordmark(size, fill, product_fill):
    a, wa = outline('TTOken', 600, size, -0.03)
    gap = size * 0.28
    b, wb = outline('Code', 400, size, -0.02)
    svg = f'<path fill="{fill}" d="{a}"/><g transform="translate({wa + gap:.2f} 0)"><path fill="{product_fill}" d="{b}"/></g>'
    return svg, wa + gap + wb

# 1. Gambar merek installer, 600x196, latar transparan.
for name, text, sub in [('brand', INK, '#55504A'), ('brand-dark', '#F9FAFB', '#B9B4AC')]:
    wm, w = wordmark(30, text, sub)
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 196" width="600" height="196">'
           f'{app_icon(244, 14, 112)}<g transform="translate({(600 - w) / 2:.2f} 178)">{wm}</g></svg>\n')
    open(f'{out}/{name}.svg', 'w', encoding='utf8').write(svg)

# 2. Sidebar uninstaller, 164x314, latar buram.
svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 164 314" width="164" height="314">'
       f'<rect width="164" height="314" fill="#F3F4F6"/>{app_icon(34, 109, 96)}</svg>\n')
open(f'{out}/uninstaller-sidebar.svg', 'w', encoding='utf8').write(svg)

# 3. Merek layar sambutan, 472x40; warna teks ikut tema lewat variabel yang sama dengan upstream.
wm, w = wordmark(26, 'var(--dsw-alias-label-primary)', 'var(--dsw-alias-label-primary)')
total = 40 + 12 + w
x0 = (472 - total) / 2
svg = ('<svg width="472" height="40" viewBox="0 0 472 40" fill="none" xmlns="http://www.w3.org/2000/svg">\n<style>\n'
       '  :root {\n    --dsw-alias-label-primary: #0f1115;\n  }\n'
       '  @media (prefers-color-scheme: dark) {\n    :root {\n      --dsw-alias-label-primary: #f9fafb;\n    }\n  }\n</style>\n'
       '<title>TTOken Code</title>\n'
       f'<g transform="translate({x0:.2f} 0) scale(0.625)">{mark("var(--dsw-alias-label-primary)")}</g>\n'
       f'<g transform="translate({x0 + 52:.2f} 29)" fill-opacity="1">{wm}</g>\n</svg>\n')
open(f'{out}/welcome-brand.svg', 'w', encoding='utf8').write(svg)
print('wordmark width @26px:', round(w, 1))
