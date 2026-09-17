#!/usr/bin/env python3
"""后期合成：把画布帧叠上页面上本来就有、但画布采集拿不到的那几层。

  暗角     #vignette 的径向渐变
  闪光     #flash，挂在断裂那一帧（events.shock）
  判词     .verdict，挂在效果结束那一帧（events.end）
  通讯     .log li.is-new 的琥珀色——文明的声音
  读数     .ctl-val 的冷蓝——观测者的手
  触点     拨动那段的手指位置（ptr）

字号按手机阅读放大：960 宽的画布在公众号里约缩到 0.39 倍，站点原来 20px 的判词
到手机上只剩 8px。

依赖 Pillow 与 numpy。字体默认取 Windows 的微软雅黑与 Consolas，别的系统用
PROMO_FONT_CJK / PROMO_FONT_CJK_BOLD / PROMO_FONT_MONO 指过去。

用法：python tools/promo-gif/compose.py [clip ...]    不给就全做
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
YAHEI = os.environ.get('PROMO_FONT_CJK', os.path.join(WINF, 'msyh.ttc'))
YAHEI_B = os.environ.get('PROMO_FONT_CJK_BOLD', os.path.join(WINF, 'msyhbd.ttc'))
MONO = os.environ.get('PROMO_FONT_MONO', os.path.join(WINF, 'consola.ttf'))

# 与 css/style.css 的 :root 一致
INK = (213, 222, 230)
INK2 = (140, 155, 168)
INK3 = (90, 103, 115)
COLD = (111, 168, 214)
AMBER = (232, 176, 75)
TAG = (92, 136, 172)     # --cold-dim 在 GIF 里太暗，提亮一档

# 各段挑哪几条通讯。全放的话升温那段 6 秒里要闪过 7 条，一条都读不完。
PICK = {
    'd_heat': ['行星均温上升', '海洋表层沸腾', '地表已无液态水'],
    'e_cold': ['冰盖越过北纬', '海洋封冻', '信号收束'],
    'f_spin': ['恒星日长度', '天空正以', '昼夜节律'],
}

_fonts = {}
def font(path, size):
    k = (path, size)
    if k not in _fonts:
        try:
            _fonts[k] = ImageFont.truetype(path, size)
        except OSError:
            sys.exit(f'找不到字体 {path}——用 PROMO_FONT_* 环境变量指定')
    return _fonts[k]


def clamp01(x):
    return max(0.0, min(1.0, x))


def cubic_bezier(x1, y1, x2, y2):
    """CSS 的 cubic-bezier 缓动：给进度 x 求 y。"""
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


# ── 文字：中西文分 run 排，mono 只管 ASCII ──
def runs(text, cjk_font, mono_font):
    out, cur, cur_f = [], '', None
    for ch in text:
        f = mono_font if (mono_font and ord(ch) < 128) else cjk_font
        if f is not cur_f and cur:
            out.append((cur, cur_f)); cur = ''
        cur_f = f; cur += ch
    if cur: out.append((cur, cur_f))
    return out


def text_width(text, f, spacing=0.0, mono=None):
    w = sum(ff.getlength(ch) + spacing for s, ff in runs(text, f, mono) for ch in s)
    return w - spacing if text else 0


def draw_text(d, xy, text, f, fill, spacing=0.0, mono=None):
    """逐字排，才能做出 letter-spacing。"""
    x, y = xy
    for s, ff in runs(text, f, mono):
        for ch in s:
            d.text((x, y), ch, font=ff, fill=fill)
            x += ff.getlength(ch) + spacing
    return x


def shadowed(paint, blur=10):
    """先画一层文字形状，模糊后当投影，再把文字盖上去——对应 CSS 的 text-shadow。"""
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


# ── 静态层 ──
def radial(stops, rx, ry, color):
    """CSS radial-gradient(ellipse rx ry at 50% 50%, ...) 的 alpha 场。"""
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    t = np.sqrt(((xs + 0.5 - W / 2) / rx) ** 2 + ((ys + 0.5 - H / 2) / ry) ** 2)
    return rgba(np.interp(t, [p for p, _ in stops], [v for _, v in stops]), color)

VIGNETTE = radial([(0.30, 0.0), (1.0, 0.55)], 1.2 * W, 0.9 * H, (0, 0, 0))
# 判词的压暗：原样是 58%×34%，字号放大后框也跟着放宽
VERDICT_BG = radial([(0.18, 0.90), (0.55, 0.55), (0.78, 0.0)], 0.66 * W, 0.40 * H, (3, 5, 8))
# 底部字幕的托底：只压下缘一条，读起来还是暗角的一部分
SCRIM = rgba(np.broadcast_to((np.clip((np.arange(H) - (H - 150)) / 150, 0, 1) ** 1.6 * 0.62)[:, None], (H, W)))


# ── 各层 ──
def layer_brand():
    def paint(d):
        draw_text(d, (40, 30), '降维打击模拟器', font(YAHEI_B, 30), INK, spacing=30 * 0.14)
        draw_text(d, (41, 76), 'DIMENSIONAL STRIKE · 高维观测者控制台', font(YAHEI, 14), INK2,
                  spacing=14 * 0.2, mono=font(MONO, 14))
        # 贴图是 CC BY 4.0，署名跟着图走
        credit = '地表影像 Solar System Scope · CC BY 4.0'
        cw = text_width(credit, font(YAHEI, 12), 0.6, font(MONO, 12))
        draw_text(d, (W - 40 - cw, H - 24), credit, font(YAHEI, 12), INK3, spacing=0.6, mono=font(MONO, 12))
    return shadowed(paint, blur=12)


def layer_command(label, tag):
    """观测者下的指令：冷蓝，左上角。"""
    def paint(d):
        draw_text(d, (40, 31), tag, font(MONO, 15), TAG, spacing=15 * 0.12)
        d.rectangle([40, 58, 42, 96], fill=COLD)
        draw_text(d, (54, 58), label, font(YAHEI_B, 28), COLD, spacing=28 * 0.12)
    return shadowed(paint)


def layer_readout(temp_k):
    """表面均温读数 + 一条迷你滑轨（90..900K，288 处标宜居），对应站点左侧面板。"""
    x0, x1, y = 40, 250, 116
    tx = x0 + (temp_k - 90) / 810 * (x1 - x0)
    def paint(d):
        draw_text(d, (40, 32), '表面均温', font(YAHEI, 17), INK2, spacing=17 * 0.06)
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
    """一条通讯记录：mono 时间戳 + 琥珀正文 + 左侧竖线。"""
    y0 = H - 92
    def paint(d):
        d.rectangle([40, y0, 41, y0 + 66], fill=AMBER)
        draw_text(d, (56, y0 - 1), f'T+{year:04d} 标准年 · 1420 MHz', font(YAHEI, 14), INK2,
                  spacing=14 * 0.08, mono=font(MONO, 15))
        draw_text(d, (56, y0 + 24), text, font(YAHEI, 27), AMBER, spacing=27 * 0.04)
    return shadowed(paint, blur=9)


def layer_verdict(text):
    lines = text.split('\n')
    f, sp, lh = font(YAHEI, 32), 32 * 0.1, 32 * 2.0
    top = H / 2 - lh * len(lines) / 2
    def paint(d):
        for i, ln in enumerate(lines):
            w = text_width(ln, f, sp)
            draw_text(d, (W / 2 - w / 2, top + i * lh + (lh - 42) / 2), ln, f, INK, spacing=sp)
    return Image.alpha_composite(VERDICT_BG, shadowed(paint, blur=14))


def layer_pointer(x, y, k, press):
    """触点：按下时从大收到小，松手时原地淡出。"""
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = 19 + 10 * (1 - press)
    d.ellipse([x - r - 10, y - r - 10, x + r + 10, y + r + 10], fill=(255, 255, 255, int(20 * k)))
    d.ellipse([x - r, y - r, x + r, y + r], fill=(255, 255, 255, int(46 * k)),
              outline=(255, 255, 255, int(230 * k)), width=3)
    d.ellipse([x - 4, y - 4, x + 4, y + 4], fill=(255, 255, 255, int(230 * k)))
    return img


def flash_alpha(t):
    """#flash 的关键帧：0 → .88（8%）→ 0，全程 520ms，整体 ease-out。"""
    if t < 0 or t > 0.52: return 0.0
    e = EASE_OUT(t / 0.52)
    return 0.88 * (e / 0.08) if e < 0.08 else 0.88 * (1 - (e - 0.08) / 0.92)


def log_track(entries, total, fade=6):
    """[(起始帧, 年, 文本)] → 每帧显示哪几条、各多少不透明度。新的一条淡入，旧的同步淡出。"""
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
    per = [[] for _ in range(n)]           # 每帧的叠加层：(图, 不透明度)
    white = [0.0] * n
    logs = []

    if clip == 'a_hero':
        brand = layer_brand()
        for f in range(n):
            per[f].append((brand, 1.0))
        # 第一声问候。采集时它落在第 0 帧，晚一点出来，先让人看清这颗星
        logs = [(18, 0, l['text']) for l in m['log'] if l['text'].startswith('检测到窄带信号')][:1]

    elif clip in ('b_foil', 'c_crush'):
        foil = clip == 'b_foil'
        cmd = layer_command('二向箔投放' if foil else '引力挤压',
                            'OBSERVER · FOIL' if foil else 'OBSERVER · CRUSH')
        verdict = layer_verdict(m['verdict'])
        t0, end = ev['trigger'], ev['end']
        for f in range(n):
            # 第 0 帧就挂着：静止时它就是这张图的标题，发动那一下再点亮
            a = (0.5 + 0.5 * clamp01((f - t0 + 1) / 5)) * (1 - clamp01((f - end) / 12))
            if a > 0: per[f].append((cmd, a))
            v = EASE(clamp01((f - end) / (1.6 * FPS)))    # .verdict 的 transition:1.6s ease
            if v > 0: per[f].append((verdict, v))
            if 'shock' in ev:
                # 断裂发生在这一帧的推进之中，取半帧作为已过去的时间
                white[f] = flash_alpha((f - ev['shock'] + 0.5) / FPS)

    elif clip in ('d_heat', 'e_cold'):
        cache = {}
        for f in range(n):
            k = int(m['temp'][f])
            if k not in cache: cache[k] = layer_readout(k)
            per[f].append((cache[k], 1.0))

    elif clip == 'f_spin':
        cmd = layer_command('抓住，拨动自转', 'OBSERVER · DRAG')
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
        # 只淡出不淡入：公众号在加载中、省电模式下只显示第一帧，黑的第一帧像是坏图。
        # 循环点于是成了「暗下去，切回开头」。
        k = clamp01((n - f) / 10)
        if k < 1: im = Image.blend(black, im, k)
        im.convert('RGB').save(os.path.join(d, f'{f:04d}.png'), compress_level=1)
    print(clip, n, '帧')


if __name__ == '__main__':
    with open(os.path.join(OUT, 'meta.json'), encoding='utf-8') as fp:
        meta = json.load(fp)
    for c in (sys.argv[1:] or sorted(meta)):
        build(c, meta[c])
