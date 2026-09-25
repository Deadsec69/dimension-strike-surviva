#!/usr/bin/env python3
"""Static file server plus the survival-mode scoring API.

The built-in http.server doesn't know the MIME types for .mjs / .wasm, so they are filled in here.
Scoring: POST /api/finish takes a snapshot, asks Gemini to read the emotion, generates a portrait for
the tier, writes it under runs/ and records it on the board.
The API key is read only from the environment or from a .env next to this file; it never enters the
repository or the page, and dotfiles are never served.
Standard library only: this repo has no pip dependencies and this file doesn't add any.
"""
import sys, os, re, json, time, base64, threading
import urllib.request, urllib.error, urllib.parse
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT  = os.path.dirname(os.path.abspath(__file__))
RUNS  = os.path.join(ROOT, 'runs')
BOARD = os.path.join(RUNS, 'leaderboard.json')
MAX_BODY  = 2 * 1024 * 1024        # a 640x480 JPEG at 0.85 is roughly 60-120KB; 2MB is the hard ceiling
GOD_SCORE, DEMIGOD_SCORE = 250, 100   # kept in sync with js/board.js: fifty / twenty asteroids' worth (5 each, and time is worth nothing)
TIERS = ('devil', 'human', 'demigod', 'god')
IMAGE_ASPECT = '16:9'                                  # landscape: the person in the middle third, the setting spread around them
IMAGE_SIZE = os.environ.get('GEMINI_IMAGE_SIZE', '1K')  # 1K at 16:9 is about 1344x768; 2K is sharper but twice as slow
API = 'https://generativelanguage.googleapis.com/v1beta/'
IMAGE_PREF = ['gemini-3.1-flash-image', 'gemini-2.5-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image']
TEXT_PREF  = ['gemini-2.5-flash', 'gemini-3.1-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite']

SimpleHTTPRequestHandler.extensions_map.update({
    '.mjs': 'text/javascript',
    '.js': 'text/javascript',
    '.wasm': 'application/wasm',
    '.task': 'application/octet-stream',
})

# -- .env: KEY=VALUE lines, # comments, optional quotes; real environment variables win --
def load_env():
    p = os.path.join(ROOT, '.env')
    if not os.path.exists(p): return
    with open(p, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line: continue
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

def api_key(): return os.environ.get('GEMINI_API_KEY', '').strip()

# -- Gemini transport --
def gcall(path, body=None, timeout=30):
    """Returns (status, json). HTTP errors come back as json rather than raising; only network
    failures and timeouts raise."""
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(API + path, data=data, method='POST' if data else 'GET',
        headers={'x-goog-api-key': api_key(), 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read().decode('utf-8', 'replace'))
        except Exception: return e.code, {'error': {'message': str(e)}}

_mlock, _models, _discovering = threading.Lock(), None, False
def models():
    """Never blocks: before anything has been listed, use the first preference (the two that work
    today) and let a background thread list /models once to calibrate.
    The listing endpoint sometimes takes a minute or two to answer (122s measured) - scoring a run
    cannot wait for it."""
    global _discovering
    if _models: return _models
    with _mlock:
        if not _discovering:
            _discovering = True
            threading.Thread(target=_discover, daemon=True).start()
    return {'image': os.environ.get('GEMINI_IMAGE_MODEL') or IMAGE_PREF[0],
            'text':  os.environ.get('GEMINI_TEXT_MODEL')  or TEXT_PREF[0]}

def _discover():
    global _models, _discovering
    try:
        names, tok = set(), None
        for _ in range(5):                                   # paging, just in case
            try:
                st, r = gcall('models?pageSize=200' + (f'&pageToken={tok}' if tok else ''), timeout=20)
            except Exception as e:
                print('listing models failed: ' + repr(e), file=sys.stderr, flush=True); break
            if st != 200: break
            names.update(m['name'].split('/', 1)[-1] for m in r.get('models', []))
            tok = r.get('nextPageToken')
            if not tok: break
        def pick(env, pref):
            if os.environ.get(env): return os.environ[env]
            return next((n for n in pref if n in names), pref[0])
        if names:
            _models = {'image': pick('GEMINI_IMAGE_MODEL', IMAGE_PREF), 'text': pick('GEMINI_TEXT_MODEL', TEXT_PREF)}
            print(f'models: text={_models["text"]} image={_models["image"]}', file=sys.stderr, flush=True)
    finally:
        _discovering = False

# -- Emotion: text model, strict JSON out, lenient parsing in --
EMOTION_PROMPT = (
    "You are the observer console of a game. The photo is the player's face at the instant their run ended. "
    "Describe their facial emotion. Reply with ONLY a JSON object, no prose, no markdown fences: "
    '{"emotion":"<one or two lowercase English words, e.g. tense, relieved, smug, blank, amused, defeated, focused>",'
    '"intensity":<integer 1-5>} '
    'If no face is visible reply {"emotion":"absent","intensity":0}.'
)
_JSON = re.compile(r'\{.*\}', re.S)
def parse_json_loose(text):
    t = re.sub(r'^\s*```(?:json)?\s*|\s*```\s*$', '', text.strip())    # strip the code fence
    m = _JSON.search(t)
    for cand in (t, m.group(0) if m else None):                        # the whole thing, then the first {...}
        if not cand: continue
        try: return json.loads(cand)
        except Exception: pass
    m = re.search(r'"emotion"\s*:\s*"([^"]+)"', t)                    # last resort: dig the field out with a regex
    return {'emotion': m.group(1)} if m else None

def read_emotion(jpeg_b64):
    model = models()['text']
    if not model: raise RuntimeError('no text model')
    cfg = {'responseMimeType': 'application/json', 'temperature': 0.2}
    if model.startswith('gemini-2.5'): cfg['thinkingConfig'] = {'thinkingBudget': 0}   # reading an expression needs no thinking, and this saves a few seconds
    st, r = gcall(f'models/{model}:generateContent', {
        'contents': [{'parts': [{'text': EMOTION_PROMPT},
                                {'inline_data': {'mime_type': 'image/jpeg', 'data': jpeg_b64}}]}],
        'generationConfig': cfg
    }, timeout=20)
    if st != 200: raise RuntimeError(f'{st} {r.get("error", {}).get("message", "")[:160]}')
    text = ''.join(p.get('text', '') for p in r['candidates'][0]['content']['parts'])
    d = parse_json_loose(text) or {}
    e = str(d.get('emotion') or 'unreadable')[:24].lower()
    try: it = int(d.get('intensity') or 0)
    except Exception: it = 0
    return {'emotion': e, 'intensity': it}

# -- Portraits: one prompt per tier. Keep the person's actual face and their expression at that moment;
#    bright, sharp and flattering. Each tier is a complete character brief - wardrobe, what they are
#    holding, the lighting, the setting - not just a different background. --
STYLE = (" Composition: medium shot from the waist up, the person centered in a wide 16:9 cinematic frame, "
         "face in the central third and perfectly sharp, hands and any held props clearly visible and well drawn. "
         "Bright high-key photoreal digital painting in full HD detail. "
         "The face is the subject: generously and evenly lit with no dark shadows on the face, "
         "a flattering professional retouch — clear smooth skin, bright clear eyes, healthy color, well-groomed hair — "
         "while keeping this exact person recognizable: face structure, hair, skin tone, glasses or accessories, "
         "and their current facial expression ({emotion}), which stays exactly as it is. "
         "Overall image bright and luminous, never murky or underexposed. No caricature, no text, no watermark.")
PORTRAIT = {
    'human': ("Reimagine the person in this photo as the last human defender of a besieged world — a battle-worn operative. "
              "Wardrobe: a fitted dark tactical jacket with a cold-blue insignia on the shoulder, a slim utility harness. "
              "Props: holding two sleek sci-fi pistols — one raised beside the chest, one at the hip — with a faint cold-blue "
              "glow at the muzzles and along their edges. "
              "Setting: a bright, clean observatory control room, a wide window full of stars with faint asteroid streaks "
              "crossing the sky, glowing consoles and holographic orbit lines. "
              "Lighting: a big soft cold-blue key light from above-front and a warm amber fill from the consoles below. "
              "Mood: determined, honest, heroic; no blood, no gore. "),
    'devil': ("Reimagine the person in this photo as the devil who just crushed a living planet with their own hand — "
              "elegant, dignified, terrifying. "
              "Props: a tall obsidian spear held upright in one hand, its blade cracked with molten light that pulses; "
              "the other hand loosely closed as if it still holds the crushed world. "
              "Wardrobe: ornate dark armor with glowing ember veins, a cape of drifting ash, small dark horns rising through the hair, "
              "eyes glowing like embers, faint hairline cracks of ember light under the skin. "
              "Setting: a hellish volcanic realm — a cavern sky full of embers and fire, molten cracks glowing in the ground, "
              "sparks and ash in the air, and shards of a broken blue planet drifting past in the background. "
              "Lighting: deep reds and oranges with a blue-white heat rim, but a warm fire key light keeps the face bright and clear. "
              "Mood: menacing, powerful, beautiful; never gory. "),
    'demigod': ("Reimagine the person in this photo as a demigod — half-ascended, between human and god, a warrior-saint. "
              "Wardrobe: burnished gold half-armor over a dark travel cloak, veins of pale light glowing along one arm and up the side "
              "of the neck and face. Effects: a crescent — a partial, not yet complete — ring of light floating behind the head, "
              "and a single wing of light spreading from one shoulder only. "
              "Props: a sword of light planted point-down under one hand, a small glowing planet hovering above the other open palm. "
              "Setting: a mountain summit above a sea of clouds at dawn, distant lightning in storm clouds on one side, "
              "pale gold and storm-blue palette. Lighting: dawn light on the face, bright and clear. "
              "Mood: resolute, on the threshold of something greater. "),
    'god':   ("Reimagine the person in this photo as a radiant, angelic god-like higher-dimensional observer. "
              "Props and effects: a large luminous golden ring — an angelic halo — floating upright behind the head and shoulders, "
              "with two smaller concentric rings of light turning around it, softly glowing runes along the rings; "
              "a radiant aura of white-gold light surrounding the whole figure; the hands open in front of the body with light "
              "gathering in the palms and tiny planets orbiting them. "
              "Wardrobe: flowing white-and-gold robes, faint feathered wings of light spreading behind the shoulders. "
              "Setting: a heavenly sky — luminous white-gold clouds, rays of sunlight breaking through, soft sky-blue and gold. "
              "Lighting: bright, glowing, celestial; skin glowing softly. "
              "Mood: serene, benevolent, immense power held calmly. "),
}
# -- Intensity: within a tier, a higher score means a fiercer image. Three levels per tier, chosen by
#    score, written into the prompt as its "Power level" paragraph. --
POWER = {
    'human': [
        (0,   "Power level: a rookie — one pistol held low, a plain jacket, the control room dim and mostly quiet, "
              "only a few faint asteroid streaks outside the window."),
        (40,  "Power level: a seasoned operative — twin pistols, harness fully rigged, consoles alive with orbit lines, "
              "many asteroid streaks crossing the window."),
        (80,  "Power level: a legend — twin pistols blazing with cold-blue light, holographic tactical overlays floating around "
              "the figure, the window ablaze with a shattering meteor swarm, medals of light on the jacket."),
    ],
    'devil': [
        (0,   "Power level: a lesser devil — small horns, a spear with only a faint ember glow, a few embers in the air, "
              "a single drifting shard of the planet."),
        (100, "Power level: a full devil — long horns, molten cracks across the armor, a storm of embers, "
              "the broken planet hanging behind in large glowing shards."),
        (250, "Power level: an archdevil — great horns, wings of fire spreading behind the shoulders, the spear blazing white-hot, "
              "a crown of flame, several crushed planets orbiting the figure, the whole sky burning."),
    ],
    'demigod': [
        (0,   "Power level: newly ascended — the crescent ring thin and faint, the single wing small and translucent, "
              "veins of light only on the hand."),
        (150, "Power level: rising — the crescent nearly three-quarters complete, the wing full and bright, veins of light "
              "reaching the face, the planet above the palm glowing strongly."),
        (200, "Power level: on the threshold of godhood — the ring almost closed and blazing, the wing vast, a second wing forming "
              "as faint light, lightning striking the summit around the figure, the armor radiant."),
    ],
    'god': [
        (0,   "Power level: a young god — one clean halo ring, a soft aura, two small planets orbiting the palms."),
        (350, "Power level: a great god — three concentric rings turning, a strong white-gold aura, wide wings of light, "
              "a dozen planets and moons orbiting the figure."),
        (500, "Power level: a supreme god — a vast mandala of rings and runes filling the sky behind, the aura blinding, "
              "enormous wings, whole galaxies and star systems spiraling around the hands."),
    ],
}
def power_of(tier, score):
    lvl, text = 1, POWER[tier][0][1]
    for i, (at, t) in enumerate(POWER[tier]):
        if score >= at: lvl, text = i + 1, t
    return lvl, text

# -- Brightness floor: the model occasionally hands back a murky image. Pillow is an optional
#    dependency in this repo (fetch-assets.sh treats it the same way): if it is present, dark images
#    get lifted a stop; if not, the prompt has to carry it. --
BRIGHT_MIN = 0.42
def brighten(data, mime):
    try:
        from PIL import Image, ImageEnhance, ImageStat
        import io
        im = Image.open(io.BytesIO(data)).convert('RGB')
        lum = ImageStat.Stat(im.convert('L')).mean[0] / 255
        if lum >= BRIGHT_MIN: return data, mime
        k = min(1.35, BRIGHT_MIN / max(lum, 0.05))
        im = ImageEnhance.Brightness(im).enhance(k)
        im = ImageEnhance.Contrast(im).enhance(1.05)
        out = io.BytesIO(); im.save(out, 'JPEG', quality=92)
        print(f'brightened: {lum:.2f} -> x{k:.2f}', file=sys.stderr, flush=True)
        return out.getvalue(), 'image/jpeg'
    except Exception:
        return data, mime

def _image_part(parts):
    for p in parts:
        d = p.get('inlineData') or p.get('inline_data')          # responses are camelCase; accept snake_case as a hedge
        if d and str(d.get('mimeType') or d.get('mime_type', '')).startswith('image/'):
            return base64.b64decode(d['data']), d.get('mimeType') or d.get('mime_type')
    return None

def _walk_image(o):                                              # Interactions responses: recurse looking for output_image / {mime_type,data}
    if isinstance(o, dict):
        if 'output_image' in o:
            r = _walk_image(o['output_image'])
            if r: return r
        mt = o.get('mime_type') or o.get('mimeType')
        if mt and o.get('data') and str(mt).startswith('image/'): return base64.b64decode(o['data']), mt
        for v in o.values():
            r = _walk_image(v)
            if r: return r
    elif isinstance(o, list):
        for v in o:
            r = _walk_image(v)
            if r: return r
    return None

def gen_portrait(jpeg_b64, tier, emotion, score=0):
    """Generate with the intensity paragraph; the model occasionally refuses to produce an image for
    the fiercest one (finishReason=NO_IMAGE), so fall back to the prompt without it and retry once."""
    power = power_of(tier, score)[1]
    try: return _gen_portrait(jpeg_b64, tier, emotion, power)
    except RuntimeError as e:
        if 'NO_IMAGE' not in str(e) or not power: raise
        print(f'portrait: intensity paragraph refused ({e}), falling back to the base prompt', file=sys.stderr, flush=True)
        return _gen_portrait(jpeg_b64, tier, emotion, '')

def _gen_portrait(jpeg_b64, tier, emotion, power):
    model = models()['image']
    if not model: raise RuntimeError('no image model')
    prompt = (PORTRAIT[tier] + power + STYLE).format(emotion=emotion or 'as seen in the photo')
    parts = [{'text': prompt}, {'inline_data': {'mime_type': 'image/jpeg', 'data': jpeg_b64}}]
    # 1) Classic generateContent. The parameters step down a ladder: with size -> aspect ratio only ->
    #    no imageConfig at all (older models) -> also asking for TEXT
    last = ''
    ladder = [
        (['IMAGE'], {'aspectRatio': IMAGE_ASPECT, 'imageSize': IMAGE_SIZE}),
        (['IMAGE'], {'aspectRatio': IMAGE_ASPECT}),
        (['IMAGE'], None),
        (['TEXT', 'IMAGE'], {'aspectRatio': IMAGE_ASPECT}),
        (['TEXT', 'IMAGE'], None),
    ]
    for mods, icfg in ladder:
        cfg = {'responseModalities': mods}
        if icfg: cfg['imageConfig'] = icfg
        st, r = gcall(f'models/{model}:generateContent',
                      {'contents': [{'parts': parts}], 'generationConfig': cfg}, timeout=75)
        if st == 200:
            c = (r.get('candidates') or [{}])[0]
            img = _image_part(c.get('content', {}).get('parts', []))
            if img:
                if icfg is None or 'imageSize' not in icfg: print(f'portrait: parameters stepped down to {icfg}', file=sys.stderr, flush=True)
                return img
            raise RuntimeError('no image part, finishReason=' + str(c.get('finishReason')))   # a safety block, among other things
        last = f'{st} {r.get("error", {}).get("message", "")[:160]}'
        if st not in (400, 404): raise RuntimeError(last)
    # 2) The newer Interactions endpoint
    st, r = gcall('interactions', {'model': model, 'input': [
        {'type': 'text', 'text': prompt}, {'type': 'image', 'mime_type': 'image/jpeg', 'data': jpeg_b64}],
        'response_format': {'type': 'image', 'aspect_ratio': IMAGE_ASPECT, 'image_size': IMAGE_SIZE}}, timeout=90)
    if st != 200: raise RuntimeError(f'generateContent {last}; interactions {st} {r.get("error", {}).get("message", "")[:160]}')
    img = _walk_image(r)
    if not img: raise RuntimeError('interactions: no image in response')
    return img

# -- Writing to disk --
_SAFE = re.compile(r'[^\w\-]+')                                  # \w covers non-ASCII letters, so a callsign in any script can be a filename
def safe_name(s):
    s = _SAFE.sub('_', str(s or '').strip())[:16].strip('_')
    return s or 'anon'

def save_image(data, mime, username, tier):
    os.makedirs(RUNS, exist_ok=True)
    ext = '.jpg' if 'jpeg' in str(mime) else '.png'
    base = time.strftime('%Y%m%d-%H%M%S') + f'_{safe_name(username)}_{tier}'
    path, n = os.path.join(RUNS, base + ext), 0
    while os.path.exists(path):
        n += 1; path = os.path.join(RUNS, f'{base}-{n}{ext}')
    with open(path + '.tmp', 'wb') as f: f.write(data)
    os.replace(path + '.tmp', path)
    return 'runs/' + urllib.parse.quote(os.path.basename(path))    # non-ASCII filenames need escaping or <img src> breaks; the path is relative so it works at any mount point

_block = threading.Lock()
def board_read():
    try:
        with open(BOARD, encoding='utf-8') as f: return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError): return []
def board_append(entry):
    with _block:                                                  # ThreadingHTTPServer: two runs scoring at once must not lose a row
        rows = board_read(); rows.append(entry)
        os.makedirs(RUNS, exist_ok=True)
        tmp = BOARD + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(rows, f, ensure_ascii=False, indent=1); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, BOARD)                                    # atomic replace: a reader always sees complete JSON
        return rows
def board_update(entry_id, patch):
    with _block:
        rows = board_read()
        for e in rows:
            if e.get('id') == entry_id: e.update(patch); break
        else: return None
        tmp = BOARD + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(rows, f, ensure_ascii=False, indent=1); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, BOARD)
        return e
def board_get(entry_id):
    return next((e for e in board_read() if e.get('id') == entry_id), None)
def board_clear():
    """Clear the board: the portrait files it references are deleted with it (only ones inside runs/),
    and the board is written as [].
    A portrait still generating in the background: board_update finds no matching id and writes
    nothing back, so the file it saves is orphaned and later clears leave it alone."""
    with _block:
        rows = board_read(); removed = 0
        root = os.path.realpath(RUNS)
        for e in rows:
            rel = e.get('portrait')
            if not rel: continue
            path = os.path.realpath(os.path.join(ROOT, rel))
            if not path.startswith(root + os.sep): continue          # only ever delete inside runs/
            try: os.remove(path); removed += 1
            except FileNotFoundError: pass
        tmp = BOARD + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump([], f); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, BOARD)
        return {'cleared': len(rows), 'files': removed}
def board_top(rows, limit):
    """The board keeps only each callsign's best run (ties go to the most recent), with runs = how many
    that callsign has played. Every run is still in the file."""
    best = {}
    for e in sorted(rows, key=lambda e: (-e.get('score', 0), e.get('ts', ''))):
        k = str(e.get('username', '')).lower()
        if k not in best: best[k] = dict(e, runs=0)
        best[k]['runs'] += 1
    return sorted(best.values(), key=lambda e: (-e.get('score', 0), e.get('ts', '')))[:limit]

# -- Scoring pipeline: a failed portrait is not a failed request --
def finish(body):
    ending = body.get('ending')
    if ending not in ('self', 'heat'): raise ValueError('ending must be self or heat (quitting mid-run is not reported)')
    username = safe_name(body.get('username'))
    score, kills, blocks = int(body.get('score') or 0), int(body.get('kills') or 0), int(body.get('blocks') or 0)
    elapsed = round(float(body.get('elapsed') or 0), 1)
    tier = body.get('tier') if body.get('tier') in TIERS else \
           ('devil' if ending == 'self' else 'god' if score >= GOD_SCORE else 'demigod' if score >= DEMIGOD_SCORE else 'human')
    snap = body.get('snapshot') or None
    if snap and snap.startswith('data:'): snap = snap.split(',', 1)[1]     # the client sends plain base64; a dataURL is accepted too
    warn = []
    if not api_key(): warn.append('no_key')
    elif not snap:    warn.append('no_snapshot')
    pending = not warn
    entry = {'id': f'{int(time.time() * 1000):x}-{os.urandom(2).hex()}', 'username': username,
             'score': score, 'kills': kills, 'blocks': blocks, 'elapsed': elapsed, 'tier': tier,
             'emotion': None, 'portrait': None, 'pending': pending,
             'ts': datetime.now().astimezone().isoformat(timespec='seconds'), 'ending': ending}
    rows = board_append(entry)                        # bank the score and return at once; the portrait takes its time in the background (Gemini sometimes needs minutes)
    if pending: threading.Thread(target=_portrait_job, args=(entry['id'], snap, tier, username, score), daemon=True).start()
    for w in warn: print('scoring degraded: ' + w, file=sys.stderr, flush=True)
    return {'entry': entry, 'leaderboard': board_top(rows, 10), 'warnings': warn}

def _portrait_job(entry_id, snap, tier, username, score=0):
    """Background: read the emotion -> generate the portrait -> brighten -> write to disk -> update that
    row on the board. The raw snapshot only ever lives in memory and is discarded when done."""
    emo, portrait, warn = None, None, []
    t0 = time.time()
    try: emo = read_emotion(snap)
    except Exception as e: warn.append(f'emotion: {e}')
    for attempt in (1, 2):                           # a momentary network drop (Errno 51, observed) shouldn't cost twenty minutes of waiting: retry once
        try:
            data, mime = gen_portrait(snap, tier, (emo or {}).get('emotion'), score)
            data, mime = brighten(data, mime)
            portrait = save_image(data, mime, username, tier)
            break
        except Exception as e:
            warn.append(f'portrait#{attempt}: {e}')
            if attempt == 1 and isinstance(e, (urllib.error.URLError, TimeoutError, OSError)): time.sleep(15); continue
            break
    board_update(entry_id, {'emotion': (emo or {}).get('emotion'),
                            'portrait': portrait, 'pending': False, 'warnings': warn})
    print(f'portrait {entry_id}: {"done " + str(portrait) if portrait else "failed"} {time.time() - t0:.0f}s' + (' ' + '; '.join(warn) if warn else ''),
          file=sys.stderr, flush=True)

class H(SimpleHTTPRequestHandler):
    def _json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        path, _, qs = self.path.partition('?')
        if any(seg.startswith('.') for seg in path.split('/')):         # .env / .git / .claude and friends all 404
            return self._json(404, {'error': 'not found'})
        if path == '/api/health':
            has = bool(api_key())
            # The probe has to answer immediately: models() doesn't block, it just kicks off the background calibration
            return self._json(200, {'ok': True, 'hasKey': has, 'models': models() if has else None, 'discovered': bool(_models), 'runs': len(board_read())})
        if path == '/api/leaderboard':
            try: limit = int((urllib.parse.parse_qs(qs).get('limit') or ['10'])[0])
            except ValueError: limit = 10
            return self._json(200, {'leaderboard': board_top(board_read(), max(1, min(50, limit)))})
        if path.startswith('/api/run/'):
            e = board_get(path.rsplit('/', 1)[-1])
            return self._json(200, {'entry': e}) if e else self._json(404, {'error': 'no such run'})
        if path.startswith('/api/'): return self._json(404, {'error': 'no such endpoint'})
        return super().do_GET()

    def do_POST(self):
        path = self.path.partition('?')[0]
        if path == '/api/leaderboard/clear':
            try: return self._json(200, {'ok': True, **board_clear()})
            except Exception as e: return self._json(500, {'error': str(e)[:200]})
        if path != '/api/finish': return self._json(404, {'error': 'no such endpoint'})
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0: return self._json(400, {'error': 'empty body'})
        if n > MAX_BODY:                                                  # answer without reading; HTTP/1.0 has no keep-alive, so the connection closes after
            self.close_connection = True
            return self._json(413, {'error': f'body > {MAX_BODY} bytes'})
        try: body = json.loads(self.rfile.read(n).decode('utf-8'))       # read(n) reads exactly n bytes; no trouble under 2MB
        except Exception: return self._json(400, {'error': 'bad json'})
        try: return self._json(200, finish(body))
        except ValueError as e: return self._json(400, {'error': str(e)})
        except Exception as e:
            print('scoring failed: ' + repr(e), file=sys.stderr, flush=True)
            return self._json(500, {'error': str(e)[:200]})

    def end_headers(self):
        # MediaPipe's GPU delegate needs cross-origin isolation in some browsers
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, fmt, *a):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % a))

if __name__ == '__main__':
    load_env()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    print('scoring: GEMINI_API_KEY ' + ('loaded' if api_key() else 'not set - portraits and emotion will degrade, the board still records'), file=sys.stderr, flush=True)
    ThreadingHTTPServer(('127.0.0.1', port), partial(H, directory=ROOT)).serve_forever()
