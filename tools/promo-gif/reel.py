#!/usr/bin/env python3
"""Highlight reel: the six clips joined into one GIF, kept under the platform's 300 frames / 10MB.

End to end and untouched the six clips run 554 frames, 46 seconds, so only the most watchable stretch
of each is used and the uneventful passages are sped up by dropping frames. Clips are separated by
dark transitions, and an end card finishes it, fading out back to the start.

The palette has to be per clip. With one palette for the whole reel, blue, white, orange and debris
all share a single table, and the orange glow around the lava gets a handful of colors and breaks into
rings. So each clip is encoded separately and their global color tables are then rewritten as
per-frame local color tables and stitched together (which GIF allows natively, and is how gifsicle
merges files too).

Usage: python tools/promo-gif/reel.py   -> out/gif/00_reel.gif
       W / COLORS override the width and color count (640 / 64 by default)
"""
import os, shutil, subprocess, tempfile
from PIL import Image

import compose as C

# (clip, [(start, end, step), ...]). Frame numbers are 24fps composited frames, and a step of 2 is
# normal speed, 3 is 1.5x, 4 is 2x.
# Every end point stays ahead of the 10-frame fade at the end of its clip.
# File size hits the ceiling before frame count does: at 720 wide this length is about 14MB. The reel
# defaults to 640 wide with 64 colors per clip - with per-clip palettes, 64 and 96 colors are
# indistinguishable by eye, and it comes to about 8.6MB.
SEGMENTS = [
    ('a_hero',  [(0, 48, 2)]),
    # The stretch where the foil approaches and the camera turns to a grazing angle is sped up; the flattening and the verdict stay at normal speed
    ('b_foil',  [(10, 70, 4), (70, 193, 3), (193, 237, 2)]),
    # Not one frame of the collapse, the fracture or the hit-stop can go. The verdict would only get a
    # second here and could not be read, so it cuts away as it lights up: the reel keeps only the
    # foil's line
    ('c_crush', [(6, 84, 2)]),
    ('d_heat',  [(15, 132, 3)]),
    ('e_cold',  [(36, 153, 3)]),
    # Flick, coast, then grab it to a stop and tip toward the north pole
    ('f_spin',  [(8, 104, 3)]),
]
FADE_IN = (0.35, 0.7)
FADE_OUT = (0.66, 0.33, 0.08)
CARD = 18
LIMIT = 300

DST = os.path.join(C.DST, 'reel')
GIF = os.path.join(C.OUT, 'gif', '00_reel.gif')
W = int(os.environ.get('W', 640))
COLORS = int(os.environ.get('COLORS', 64))
MAX_BYTES = 10_000_000       # treat the platform's "10M" as decimal, the most conservative reading


def end_card():
    """End card: the title and the address over a darkened planet."""
    im = Image.open(os.path.join(C.SRC, 'a_hero', '0000.png')).convert('RGBA')
    im = Image.alpha_composite(im, C.VIGNETTE)
    im = Image.alpha_composite(im, Image.new('RGBA', (C.W, C.H), (3, 5, 8, 190)))

    def paint(d):
        def center(y, text, f, fill, sp=0.0, mono=None):
            w = C.text_width(text, f, sp, mono)
            C.draw_text(d, (C.W / 2 - w / 2, y), text, f, fill, spacing=sp, mono=mono)
        center(196, 'Dimensional Strike', C.font(C.UI_B, 50), C.INK, 50 * 0.14)
        center(274, 'SIMULATOR · HIGH-DIMENSIONAL OBSERVER CONSOLE', C.font(C.UI, 17), C.INK2,
               17 * 0.2, C.font(C.MONO, 17))
        center(330, 'mr-salticidae.github.io/dimension-strike', C.font(C.MONO, 22), C.COLD, 22 * 0.04)
        credit = 'Surface imagery Solar System Scope · CC BY 4.0'
        cw = C.text_width(credit, C.font(C.UI, 12), 0.6, C.font(C.MONO, 12))
        C.draw_text(d, (C.W - 40 - cw, C.H - 24), credit, C.font(C.UI, 12), C.INK3,
                    spacing=0.6, mono=C.font(C.MONO, 12))
    return Image.alpha_composite(im, C.shadowed(paint, blur=14)).convert('RGB')


def encode(src, out):
    """The same parameters as encode.sh, except the frames are already laid out at 12fps and nothing is skipped."""
    vf = (f'scale={W}:-2:flags=lanczos,split[s0][s1];'
          f'[s0]palettegen=max_colors={COLORS}:stats_mode=full[p];'
          f'[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', '12',
                    '-i', os.path.join(src, '%04d.png'), '-vf', vf, '-r', '12', out], check=True)


def parse_gif(data):
    """Split out the logical screen descriptor, global color table, loop extension and, per frame, the
    (graphic control extension, image descriptor, local color table, image data)."""
    if data[:6] not in (b'GIF87a', b'GIF89a'):
        raise ValueError('not a GIF')
    lsd = data[6:13]
    p, gct = 13, b''
    if lsd[4] & 0x80:
        n = 3 << ((lsd[4] & 7) + 1)
        gct, p = data[p:p + n], p + n

    def skip_subblocks(q):
        while data[q]:
            q += data[q] + 1
        return q + 1

    frames, gce, app = [], b'', b''
    while True:
        b = data[p]
        if b == 0x21:                              # extension block
            q = skip_subblocks(p + 2)
            if data[p + 1] == 0xF9: gce = data[p:q]
            elif data[p + 1] == 0xFF and not app: app = data[p:q]
            p = q
        elif b == 0x2C:                            # image
            desc, q, lct = data[p + 1:p + 10], p + 10, b''
            if desc[8] & 0x80:
                n = 3 << ((desc[8] & 7) + 1)
                lct, q = data[q:q + n], q + n
            end = skip_subblocks(q + 1)            # preceded by one byte of LZW minimum code size
            frames.append((gce, desc, lct, data[q:end]))
            gce, p = b'', end
        elif b == 0x3B:
            return lsd, gct, app, frames
        else:
            raise ValueError(f'unparseable block 0x{b:02x} @ {p}')


def merge_gifs(paths, out):
    """Rewrite the later clips' global color tables as local color tables on each of their frames. The
    first frame of every clip is a full opaque image and depends on nothing before it."""
    parts = [parse_gif(open(p, 'rb').read()) for p in paths]
    lsd, gct, app, _ = parts[0]
    buf = bytearray(b'GIF89a' + lsd + gct + app)
    for i, (lsd_i, gct_i, _, frames) in enumerate(parts):
        if lsd_i[:4] != lsd[:4]:
            raise ValueError('clip dimensions do not match')
        for gce, desc, lct, img in frames:
            if i > 0 and not lct:
                desc = desc[:8] + bytes([(desc[8] & 0x60) | 0x80 | (lsd_i[4] & 7)])
                lct = gct_i
            buf += gce + b'\x2c' + desc + lct + img      # 0x2C image separator
    buf += b'\x3b'                                       # 0x3B trailer
    with open(out, 'wb') as f:
        f.write(buf)


def main():
    segs = []                                    # [(name, [(image path or None, brightness)])]
    for s, (clip, cuts) in enumerate(SEGMENTS):
        idx = [i for a, b, step in cuts for i in range(a, b, step)]
        seg = [[os.path.join(C.DST, clip, f'{i:04d}.png'), 1.0] for i in idx]
        if s > 0:                                # the first clip never fades in: the first frame must not be black
            for k, v in enumerate(FADE_IN): seg[k][1] = min(seg[k][1], v)
        for k, v in enumerate(FADE_OUT): seg[-len(FADE_OUT) + k][1] = min(seg[-len(FADE_OUT) + k][1], v)
        segs.append((clip, seg))

    card = [[None, 1.0] for _ in range(CARD)]
    for k, v in enumerate(FADE_IN): card[k][1] = v
    for k, v in enumerate(FADE_OUT): card[-len(FADE_OUT) + k][1] = v
    segs.append(('card', card))

    total = sum(len(seg) for _, seg in segs)
    for name, seg in segs:
        print(f'{name:8s} {len(seg):3d} frames')
    print(f'{total} frames total / {total / 12:.1f}s')
    if total > LIMIT:
        raise SystemExit(f'over the {LIMIT} frame limit - tighten SEGMENTS')

    shutil.rmtree(DST, ignore_errors=True)
    card_im = end_card()
    black = Image.new('RGB', (C.W, C.H), (0, 0, 0))
    tmp = tempfile.mkdtemp()
    parts = []
    try:
        for s, (name, seg) in enumerate(segs):
            d = os.path.join(DST, f'{s}_{name}')
            os.makedirs(d)
            for n, (path, k) in enumerate(seg):
                im = card_im if path is None else Image.open(path).convert('RGB')
                if k < 1: im = Image.blend(black, im, k)
                im.save(os.path.join(d, f'{n:04d}.png'), compress_level=1)
            parts.append(os.path.join(tmp, f'{s}.gif'))
            encode(d, parts[-1])
        os.makedirs(os.path.dirname(GIF), exist_ok=True)
        merge_gifs(parts, GIF)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    size = os.path.getsize(GIF)
    print(f'{os.path.basename(GIF)}  {size / 1e6:.2f} MB  {W} wide  {COLORS} colors/clip')
    if size > MAX_BYTES:
        raise SystemExit('over the 10MB limit: lower W / COLORS or tighten SEGMENTS')


if __name__ == '__main__':
    main()
