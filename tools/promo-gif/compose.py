#!/usr/bin/env python3
"""Compositing: overlay the layers the page already has but a canvas capture cannot see.

  vignette   the radial gradient of #vignette
  flash      #flash, hung on the frame it fractures (events.shock)
  verdict    .verdict, hung on the frame the effect ends (events.end)
  comms      the amber of .log li.is-new - the civilization's voice
  readout    the cold blue of .ctl-val - the observer's hand
  touch      the finger position during the spin clip (ptr)

Type is scaled up for reading on a phone: a 960-wide canvas ends up around 0.39x in a feed, and the
site's 20px verdict would be 8px there.

Depends on Pillow and numpy. The fonts default to the Windows Segoe UI and Consolas; point
PROMO_FONT_UI / PROMO_FONT_UI_BOLD / PROMO_FONT_MONO elsewhere on other systems.

Usage: python tools/promo-gif/compose.py [clip ...]   with no arguments it does all of them
"""
import json, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
SRC = os.path.join(OUT, 'frames')
DST = os.path.join(OUT, 'comp')
W, H = 960, 540
FPS = 24

WINF = os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts')
UI = os.environ.get('PROMO_FONT_UI', os.path.join(WINF, 'segoeui.ttf'))
UI_B = os.environ.get('PROMO_FONT_UI_BOLD', os.path.join(WINF, 'segoeuib.ttf'))
MONO = os.environ.get('PROMO_FONT_MONO', os.path.join(WINF, 'consola.ttf'))

# Matches the :root block in css/style.css
INK = (213, 222, 230)
INK2 = (140, 155, 168)
INK3 = (90, 103, 115)
COLD = (111, 168, 214)
AMBER = (232, 176, 75)
TAG = (92, 136, 172)     # --cold-dim is too dark once it is a GIF, so it is lifted a stop

# Which comms lines each clip uses. Showing all of them would flash seven lines through the six
# seconds of the heating clip and none of them could be read.
PICK = {
    'd_heat': ['Mean temperature up', 'Ocean surface boiling', 'No liquid water left'],
    'e_cold': ['Ice sheets pass', 'Oceans frozen over', 'The signal collapses'],
    'f_spin': ['Unexplained drift', 'The sky is moving', 'Circadian rhythms'],
}

_fonts = {}
def font(path, size):
    k = (path, size)
    if k not in _fonts:
        try:
            _fonts[k] = ImageFont.truetype(path, size)
        except OSError:
            sys.exit(f'font not found: {path} - point PROMO_FONT_* at one that exists')
    return _fonts[k]


def clamp01(x):
    return max(0.0, min(1.0, x))


def cubic_bezier(x1, y1, x2, y2):
    """CSS cubic-bezier easing: given progress x, solve for y."""
    def bz(t, a, b):
        return 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3
    def f(x):
        x = clamp01(x)
        lo, hi = 0.0, 1.0
        for _ in range(30):
            mid = (lo + hi) / 2
            if bz(mid, x1, x2) < x: lo = mid
            else: hi = mid
        return bz((lo + hi) / 2, y1, y2)
    return f

EASE = cubic_bezier(0.25, 0.1, 0.25, 1.0)
EASE_OUT = cubic_bezier(0.0, 0.0, 0.58, 1.0)


# -- Text: laid out in runs so a mono font can cover ASCII while another covers the rest --
def runs(text, ui_font, mono_font):
    out, cur, cur_f = [], '', None
    for ch in text:
        f = mono_font if (mono_font and ord(ch) < 128) else ui_font
        if f is not cur_f and cur:
            out.append((cur, cur_f)); cur = ''
        cur_f = f; cur += ch
    if cur: out.append((cur, cur_f))
    return out


def text_width(text, f, spacing=0.0, mono=None):
    w = sum(ff.getlength(ch) + spacing for s, ff in runs(text, f, mono) for ch in s)
    return w - spacing if text else 0


def draw_text(d, xy, text, f, fill, spacing=0.0, mono=None):
    """Laid out character by character, which is the only way to get letter-spacing."""
    x, y = xy
    for s, ff in runs(text, f, mono):
        for ch in s:
            d.text((x, y), ch, font=ff, fill=fill)
            x += ff.getlength(ch) + spacing
    return x


def shadowed(paint, blur=10):
    """Draw the glyph shapes once, blur them into a shadow, then draw the text on top - the equivalent of CSS text-shadow."""
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    paint(ImageDraw.Draw(layer))
    a = layer.getchannel('A').filter(ImageFilter.GaussianBlur(blur)).point(lambda v: min(255, int(v * 2.0)))
    shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    shadow.putalpha(a)
    return Image.alpha_composite(shadow, layer)


def with_alpha(img, k):
    if k >= 0.999: return img
    img = img.copy()
    img.putalpha(img.getchannel('A').point(lambda v: int(v * k)))
    return img


def rgba(alpha, color=(0, 0, 0)):
    out = np.zeros((H, W, 4), np.uint8)
    out[..., :3] = color
    out[..., 3] = np.clip(alpha * 255, 0, 255).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')


# -- Static layers --
def radial(stops, rx, ry, color):
    """The alpha field of CSS radial-gradient(ellipse rx ry at 50% 50%, ...)."""
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    t = np.sqrt(((xs + 0.5 - W / 2) / rx) ** 2 + ((ys + 0.5 - H / 2) / ry) ** 2)
    return rgba(np.interp(t, [p for p, _ in stops], [v for _, v in stops]), color)

VIGNETTE = radial([(0.30, 0.0), (1.0, 0.55)], 1.2 * W, 0.9 * H, (0, 0, 0))
# Darkening behind the verdict: 58%x34% originally, widened along with the larger type
VERDICT_BG = radial([(0.18, 0.90), (0.55, 0.55), (0.78, 0.0)], 0.66 * W, 0.40 * H, (3, 5, 8))
# A base behind the bottom subtitles: only the lower edge is darkened, so it still reads as part of the vignette
SCRIM = rgba(np.broadcast_to((np.clip((np.arange(H) - (H - 150)) / 150, 0, 1) ** 1.6 * 0.62)[:, None], (H, W)))


# -- The layers --
def layer_brand():
    def paint(d):
        draw_text(d, (40, 30), 'Dimensional Strike', font(UI_B, 30), INK, spacing=30 * 0.14)
        draw_text(d, (41, 76), 'SIMULATOR · HIGH-DIMENSIONAL OBSERVER CONSOLE', font(UI, 14), INK2,
                  spacing=14 * 0.2, mono=font(MONO, 14))
        # The textures are CC BY 4.0, and the attribution travels with the image
        credit = 'Surface imagery Solar System Scope · CC BY 4.0'
        cw = text_width(credit, font(UI, 12), 0.6, font(MONO, 12))
        draw_text(d, (W - 40 - cw, H - 24), credit, font(UI, 12), INK3, spacing=0.6, mono=font(MONO, 12))
    return shadowed(paint, blur=12)


def layer_command(label, tag):
    """A command from the observer: cold blue, top left."""
    def paint(d):
        draw_text(d, (40, 31), tag, font(MONO, 15), TAG, spacing=15 * 0.12)
        d.rectangle([40, 58, 42, 96], fill=COLD)
        draw_text(d, (54, 58), label, font(UI_B, 28), COLD, spacing=28 * 0.12)
    return shadowed(paint)


def layer_readout(temp_k):
    """The mean surface temperature readout plus a mini slider (90..900K, habitable marked at 288), mirroring the site's left panel."""
    x0, x1, y = 40, 250, 116
    tx = x0 + (temp_k - 90) / 810 * (x1 - x0)
    def paint(d):
        draw_text(d, (40, 32), 'Mean surface temperature', font(UI, 17), INK2, spacing=17 * 0.06)
        x = draw_text(d, (40, 56), f'{temp_k:d}', font(MONO, 38), COLD)
        d.text((x + 6, 72), 'K', font=font(MONO, 17), fill=INK3)
        d.rectangle([x0, y, x1, y + 1], fill=(62, 80, 96))
        ideal = x0 + (288 - 90) / 810 * (x1 - x0)
        d.rectangle([ideal, y - 4, ideal, y + 5], fill=INK3)
        d.rectangle([tx - 1, y - 7, tx + 1, y + 8], fill=COLD)
    glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([tx - 9, y - 9, tx + 9, y + 9], fill=COLD + (150,))
    return Image.alpha_composite(glow.filter(ImageFilter.GaussianBlur(6)), shadowed(paint))


def layer_log(year, text):
    """One comms entry: a mono timestamp, amber body text, and a rule down the left."""
    y0 = H - 92
    def paint(d):
        d.rectangle([40, y0, 41, y0 + 66], fill=AMBER)
        draw_text(d, (56, y0 - 1), f'T+{year:04d} STD YR · 1420 MHz', font(UI, 14), INK2,
                  spacing=14 * 0.08, mono=font(MONO, 15))
        draw_text(d, (56, y0 + 24), text, font(UI, 27), AMBER, spacing=27 * 0.04)
    return shadowed(paint, blur=9)


def layer_verdict(text):
    lines = text.split('\n')
    f, sp, lh = font(UI, 32), 32 * 0.1, 32 * 2.0
    top = H / 2 - lh * len(lines) / 2
    def paint(d):
        for i, ln in enumerate(lines):
            w = text_width(ln, f, sp)
            draw_text(d, (W / 2 - w / 2, top + i * lh + (lh - 42) / 2), ln, f, INK, spacing=sp)
    return Image.alpha_composite(VERDICT_BG, shadowed(paint, blur=14))


def layer_pointer(x, y, k, press):
    """The touch point: contracts from large on press, and fades in place on release."""
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = 19 + 10 * (1 - press)
    d.ellipse([x - r - 10, y - r - 10, x + r + 10, y + r + 10], fill=(255, 255, 255, int(20 * k)))
    d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, int(46 * k)),
              outline=(255, 255, 255, int(230 * k)), width=3)
    d.ellipse([x - 4, y - 4, x + 4, y + 4], fill=(255, 255, 255, int(230 * k)))
    return img


def flash_alpha(t):
    """#flash's keyframes: 0 -> .88 (at 8%) -> 0 over 520ms, eased out overall."""
    if t < 0 or t > 0.52: return 0.0
    e = EASE_OUT(t / 0.52)
    return 0.88 * (e / 0.08) if e < 0.08 else 0.88 * (1 - (e - 0.08) / 0.92)


def log_track(entries, total, fade=6):
    """[(start frame, year, text)] -> which entries each frame shows and at what opacity. A new entry fades in as the old one fades out."""
    track = [[] for _ in range(total)]
    for n, (f0, year, text) in enumerate(entries):
        f1 = entries[n + 1][0] if n + 1 < len(entries) else total + fade
        for f in range(f0, min(total, f1 + fade)):
            a = clamp01((f - f0 + 1) / fade)
            if f >= f1: a *= clamp01(1 - (f - f1 + 1) / fade)
            if a > 0: track[f].append((a, year, text))
    return track


def build(clip, m):
    n, ev = m['frames'], m['events']
    per = [[] for _ in range(n)]           # per-frame overlays: (image, opacity)
    white = [0.0] * n
    logs = []

    if clip == 'a_hero':
        brand = layer_brand()
        for f in range(n):
            per[f].append((brand, 1.0))
        # The opening greeting. During capture it lands on frame 0; delay it a little so the planet registers first
        logs = [(18, 0, l['text']) for l in m['log'] if l['text'].startswith('Narrowband signal detected')][:1]

    elif clip in ('b_foil', 'c_crush'):
        foil = clip == 'b_foil'
        cmd = layer_command('Dual-Vector Foil' if foil else 'Gravity Crush',
                            'OBSERVER · FOIL' if foil else 'OBSERVER · CRUSH')
        verdict = layer_verdict(m['verdict'])
        t0, end = ev['trigger'], ev['end']
        for f in range(n):
            # Present from frame 0: while nothing is moving it is this image's title, and it lights up as the strike fires
            a = (0.5 + 0.5 * clamp01((f - t0 + 1) / 5)) * (1 - clamp01((f - end) / 12))
            if a > 0: per[f].append((cmd, a))
            v = EASE(clamp01((f - end) / (1.6 * FPS)))    # .verdict's transition: 1.6s ease
            if v > 0: per[f].append((verdict, v))
            if 'shock' in ev:
                # The fracture happens partway through this frame's step, so half a frame is taken as elapsed
                white[f] = flash_alpha((f - ev['shock'] + 0.5) / FPS)

    elif clip in ('d_heat', 'e_cold'):
        cache = {}
        for f in range(n):
            k = int(m['temp'][f])
            if k not in cache: cache[k] = layer_readout(k)
            per[f].append((cache[k], 1.0))

    elif clip == 'f_spin':
        cmd = layer_command('Grab it and spin', 'OBSERVER · DRAG')
        down = up = last = None
        for f, p in enumerate(m['ptr']):
            per[f].append((cmd, 1.0))
            if p:
                if last is None or up is not None: down, up = f, None
                last = p
                per[f].append((layer_pointer(p[0], p[1], 1.0, clamp01((f - down + 1) / 4)), 1.0))
            elif last is not None:
                if up is None: up = f
                k = 1 - (f - up + 1) / 6
                if k > 0: per[f].append((layer_pointer(last[0], last[1], k, 1.0), 1.0))

    if clip in PICK:
        logs = [(l['f'], l['year'], l['text']) for l in m['log']
                if any(l['text'].startswith(p) for p in PICK[clip])]
    cache = {}
    for f, items in enumerate(log_track(logs, n)):
        for a, year, text in items:
            if (year, text) not in cache: cache[year, text] = layer_log(year, text)
            per[f].append((cache[year, text], a))

    d = os.path.join(DST, clip)
    os.makedirs(d, exist_ok=True)
    for old in os.listdir(d):
        os.remove(os.path.join(d, old))
    black = Image.new('RGBA', (W, H), (0, 0, 0, 255))
    flash = Image.new('RGBA', (W, H), (255, 255, 255, 255))
    for f in range(n):
        im = Image.open(os.path.join(SRC, clip, f'{f:04d}.png')).convert('RGBA')
        if white[f] > 0: im = Image.blend(im, flash, white[f])
        im = Image.alpha_composite(im, VIGNETTE)
        if logs: im = Image.alpha_composite(im, SCRIM)
        for layer, a in per[f]:
            im = Image.alpha_composite(im, with_alpha(layer, a))
        # Fade out but never in: while loading, and in power saving mode, only the first frame is shown,
        # and a black first frame looks like a broken image. The loop point becomes "go dark, cut back
        # to the start".
        k = clamp01((n - f) / 10)
        if k < 1: im = Image.blend(black, im, k)
        im.convert('RGB').save(os.path.join(d, f'{f:04d}.png'), compress_level=1)
    print(clip, n, 'frames')


if __name__ == '__main__':
    with open(os.path.join(OUT, 'meta.json'), encoding='utf-8') as fp:
        meta = json.load(fp)
    for c in (sys.argv[1:] or sorted(meta)):
        build(c, meta[c])
