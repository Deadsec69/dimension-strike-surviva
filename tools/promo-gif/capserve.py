#!/usr/bin/env python3
"""Capture server for the promo GIFs: serves the site and receives the frames the page POSTs back.

Same origin is the point - the page can fetch('/frame/...') directly with no CORS to worry about.
/capture.html is index.html with one line appended that injects capture.js; the site itself carries no
capture code at all.
Capture is finished once the page posts its meta back, and the server exits immediately after.

Usage: python tools/promo-gif/capserve.py [--port 8125] [--clips b_foil,c_crush] [--no-open]
"""
import argparse, base64, json, os, re, shutil, sys, threading, webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, 'out')
FRAMES = os.path.join(OUT, 'frames')
META = os.path.join(OUT, 'meta.json')

SimpleHTTPRequestHandler.extensions_map.update({
    '.mjs': 'text/javascript', '.js': 'text/javascript',
    '.wasm': 'application/wasm', '.task': 'application/octet-stream',
})

INJECT = b'<script type="module" src="./tools/promo-gif/capture.js"></script>\n</body>'
CLIP = re.compile(r'^[a-z0-9_]+$')


class H(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.split('?')[0] != '/capture.html':
            return super().do_GET()
        with open(os.path.join(ROOT, 'index.html'), 'rb') as f:
            body = f.read().replace(b'</body>', INJECT)
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        parts = self.path.strip('/').split('/')
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        try:
            kind = parts[0]
            if kind in ('frame', 'reset') and not CLIP.match(parts[1]):
                raise ValueError('illegal clip name ' + parts[1])
            if kind == 'frame':              # frame/<clip>/<idx>, with a dataURL as the body
                d = os.path.join(FRAMES, parts[1])
                os.makedirs(d, exist_ok=True)
                with open(os.path.join(d, '%04d.png' % int(parts[2])), 'wb') as f:
                    f.write(base64.b64decode(body.split(b',', 1)[1]))
            elif kind == 'reset':            # clear old frames before a retake: a shorter new take would otherwise leave the old tail behind
                shutil.rmtree(os.path.join(FRAMES, parts[1]), ignore_errors=True)
                print('capturing ' + parts[1], flush=True)
            elif kind == 'meta':             # done. Merged into the existing meta so a partial retake doesn't lose the other clips
                meta = {}
                if os.path.exists(META):
                    with open(META, encoding='utf-8') as f:
                        meta = json.load(f)
                meta.update(json.loads(body))
                with open(META, 'w', encoding='utf-8') as f:
                    json.dump(meta, f, ensure_ascii=False)
                print('capture complete -> ' + OUT, flush=True)
                self.server.result = 0
            elif kind == 'fail':
                print('capture failed: ' + body.decode('utf-8', 'replace'), file=sys.stderr, flush=True)
                self.server.result = 1
            else:
                self.send_error(404)
                return
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(str(e).encode())
            return
        self.send_response(204)
        self.end_headers()
        if self.server.result is not None:
            threading.Thread(target=self.server.shutdown, daemon=True).start()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8125)
    ap.add_argument('--clips', help='capture only these clips, comma separated; all of them if omitted')
    ap.add_argument('--no-open', action='store_true', help="don't open a browser automatically")
    args = ap.parse_args()

    os.makedirs(FRAMES, exist_ok=True)
    srv = ThreadingHTTPServer(('127.0.0.1', args.port), partial(H, directory=ROOT))
    srv.result = None
    url = 'http://127.0.0.1:%d/capture.html' % args.port
    if args.clips:
        url += '?clips=' + args.clips
    print('capture page: ' + url, flush=True)
    if not args.no_open:
        webbrowser.open(url)
    srv.serve_forever()
    sys.exit(srv.result or 0)
