#!/usr/bin/env python3
"""精华合集：六段接成一张 GIF，压在公众号的 300 帧 / 10MB 以内。

六段原样首尾相接是 554 帧、46 秒，所以每段只取最有看头的一截，没事发生的段落
抽帧快放。段与段之间暗场过渡；末尾一张片尾卡，淡出后接回开头。

调色板必须按段分。整部共用一张的话，蓝、白、橙、碎片挤在同一张表里，熔岩外那圈
橙色辉光只分到几个颜色，一圈圈断开。所以每段单独编码，再把各段的全局色表改写成
各帧的局部色表拼起来（GIF 本来就允许，gifsicle 合并也是这么做的）。

用法：python tools/promo-gif/reel.py    → out/gif/00_精华合集.gif
      宽度与色数可用 W / COLORS 环境变量覆盖（默认 640 / 64）
"""
import os, shutil, subprocess, tempfile
from PIL import Image

import compose as C

# (片段, [(起, 止, 步长), ...])。帧号是 24fps 的合成帧，步长 2 = 原速，3 = 1.5 倍，4 = 2 倍。
# 止点都要早于各段末尾那 10 帧淡出。
# 体积比帧数先到顶：720 宽照这个长度约 14MB。合集默认 640 宽、每段 64 色——
# 按段分了调色板，64 色和 96 色肉眼无差，约 8.6MB。
SEGMENTS = [
    ('a_hero',  [(0, 48, 2)]),
    # 箔片飞近、镜头转到掠射角那一截快放；压平与判词保留原速
    ('b_foil',  [(10, 70, 4), (70, 193, 3), (193, 237, 2)]),
    # 塌缩、断裂、停顿一帧不能少。判词在合集里只够露一秒、读不完，在它亮起时切走，
    # 合集只留二向箔那一句
    ('c_crush', [(6, 84, 2)]),
    ('d_heat',  [(15, 132, 3)]),
    ('e_cold',  [(36, 153, 3)]),
    # 甩出去、滑行、抓停扳向北极
    ('f_spin',  [(8, 104, 3)]),
]
FADE_IN = (0.35, 0.7)
FADE_OUT = (0.66, 0.33, 0.08)
CARD = 18
LIMIT = 300

DST = os.path.join(C.DST, 'reel')
GIF = os.path.join(C.OUT, 'gif', '00_精华合集.gif')
W = int(os.environ.get('W', 640))
COLORS = int(os.environ.get('COLORS', 64))
MAX_BYTES = 10_000_000       # 公众号的「10M」按最保守的十进制算


def end_card():
    """片尾：压暗的行星上叠标题和地址。"""
    im = Image.open(os.path.join(C.SRC, 'a_hero', '0000.png')).convert('RGBA')
    im = Image.alpha_composite(im, C.VIGNETTE)
    im = Image.alpha_composite(im, Image.new('RGBA', (C.W, C.H), (3, 5, 8, 190)))

    def paint(d):
        def center(y, text, f, fill, sp=0.0, mono=None):
            w = C.text_width(text, f, sp, mono)
            C.draw_text(d, (C.W / 2 - w / 2, y), text, f, fill, spacing=sp, mono=mono)
        center(196, '降维打击模拟器', C.font(C.YAHEI_B, 50), C.INK, 50 * 0.14)
        center(274, 'DIMENSIONAL STRIKE · 高维观测者控制台', C.font(C.YAHEI, 17), C.INK2,
               17 * 0.2, C.font(C.MONO, 17))
        center(330, 'mr-salticidae.github.io/dimension-strike', C.font(C.MONO, 22), C.COLD, 22 * 0.04)
        credit = '地表影像 Solar System Scope · CC BY 4.0'
        cw = C.text_width(credit, C.font(C.YAHEI, 12), 0.6, C.font(C.MONO, 12))
        C.draw_text(d, (C.W - 40 - cw, C.H - 24), credit, C.font(C.YAHEI, 12), C.INK3,
                    spacing=0.6, mono=C.font(C.MONO, 12))
    return Image.alpha_composite(im, C.shadowed(paint, blur=14)).convert('RGB')


def encode(src, out):
    """与 encode.sh 同一套参数，只是帧已按 12fps 排好，不再隔帧抽。"""
    vf = (f'scale={W}:-2:flags=lanczos,split[s0][s1];'
          f'[s0]palettegen=max_colors={COLORS}:stats_mode=full[p];'
          f'[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-framerate', '12',
                    '-i', os.path.join(src, '%04d.png'), '-vf', vf, '-r', '12', out], check=True)


def parse_gif(data):
    """拆出逻辑屏幕描述符、全局色表、循环扩展和各帧 (图形控制扩展, 图像描述符, 局部色表, 图像数据)。"""
    if data[:6] not in (b'GIF87a', b'GIF89a'):
        raise ValueError('不是 GIF')
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
        if b == 0x21:                              # 扩展块
            q = skip_subblocks(p + 2)
            if data[p + 1] == 0xF9: gce = data[p:q]
            elif data[p + 1] == 0xFF and not app: app = data[p:q]
            p = q
        elif b == 0x2C:                            # 图像
            desc, q, lct = data[p + 1:p + 10], p + 10, b''
            if desc[8] & 0x80:
                n = 3 << ((desc[8] & 7) + 1)
                lct, q = data[q:q + n], q + n
            end = skip_subblocks(q + 1)            # 先是 1 字节 LZW 最小码长
            frames.append((gce, desc, lct, data[q:end]))
            gce, p = b'', end
        elif b == 0x3B:
            return lsd, gct, app, frames
        else:
            raise ValueError(f'无法解析的块 0x{b:02x} @ {p}')


def merge_gifs(paths, out):
    """后几段的全局色表改写成它们各帧的局部色表。每段第一帧都是整幅不透明的，不依赖前一段。"""
    parts = [parse_gif(open(p, 'rb').read()) for p in paths]
    lsd, gct, app, _ = parts[0]
    buf = bytearray(b'GIF89a' + lsd + gct + app)
    for i, (lsd_i, gct_i, _, frames) in enumerate(parts):
        if lsd_i[:4] != lsd[:4]:
            raise ValueError('各段画幅不一致')
        for gce, desc, lct, img in frames:
            if i > 0 and not lct:
                desc = desc[:8] + bytes([(desc[8] & 0x60) | 0x80 | (lsd_i[4] & 7)])
                lct = gct_i
            buf += gce + b'\x2c' + desc + lct + img      # 0x2C 图像分隔符
    buf += b'\x3b'                                       # 0x3B 文件结尾
    with open(out, 'wb') as f:
        f.write(buf)


def main():
    segs = []                                    # [(名字, [(图片路径或 None, 亮度)])]
    for s, (clip, cuts) in enumerate(SEGMENTS):
        idx = [i for a, b, step in cuts for i in range(a, b, step)]
        seg = [[os.path.join(C.DST, clip, f'{i:04d}.png'), 1.0] for i in idx]
        if s > 0:                                # 第一段不淡入：首帧不能是黑的
            for k, v in enumerate(FADE_IN): seg[k][1] = min(seg[k][1], v)
        for k, v in enumerate(FADE_OUT): seg[-len(FADE_OUT) + k][1] = min(seg[-len(FADE_OUT) + k][1], v)
        segs.append((clip, seg))

    card = [[None, 1.0] for _ in range(CARD)]
    for k, v in enumerate(FADE_IN): card[k][1] = v
    for k, v in enumerate(FADE_OUT): card[-len(FADE_OUT) + k][1] = v
    segs.append(('card', card))

    total = sum(len(seg) for _, seg in segs)
    for name, seg in segs:
        print(f'{name:8s} {len(seg):3d} 帧')
    print(f'合计 {total} 帧 / {total / 12:.1f} 秒')
    if total > LIMIT:
        raise SystemExit(f'超过公众号 {LIMIT} 帧上限，收紧 SEGMENTS')

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
    print(f'{os.path.basename(GIF)}  {size / 1e6:.2f} MB  {W} 宽  {COLORS} 色/段')
    if size > MAX_BYTES:
        raise SystemExit('超过公众号 10MB 上限：调小 W / COLORS 或收紧 SEGMENTS')


if __name__ == '__main__':
    main()
