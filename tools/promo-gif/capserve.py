#!/usr/bin/env python3
"""宣传 GIF 的采集服务器：既发站点，又收页面 POST 回来的帧。

同源是关键——页面直接 fetch('/frame/...')，不必操心 CORS。
/capture.html 是 index.html 末尾注入一行 capture.js，站点本身不带任何采集代码。
页面把 meta 发回来就算采完，服务器随即退出。

用法：python tools/promo-gif/capserve.py [--port 8125] [--clips b_foil,c_crush] [--no-open]
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
                raise ValueError('非法片段名 ' + parts[1])
            if kind == 'frame':              # frame/<clip>/<idx>，body 是 dataURL
                d = os.path.join(FRAMES, parts[1])
                os.makedirs(d, exist_ok=True)
                with open(os.path.join(d, '%04d.png' % int(parts[2])), 'wb') as f:
                    f.write(base64.b64decode(body.split(b',', 1)[1]))
            elif kind == 'reset':            # 重拍前清掉旧帧：新拍的一段比旧的短，旧尾巴会混进来
                shutil.rmtree(os.path.join(FRAMES, parts[1]), ignore_errors=True)
                print('采集 ' + parts[1], flush=True)
            elif kind == 'meta':             # 采完了。并进已有的 meta，只重拍几段时其余几段不丢
                meta = {}
                if os.path.exists(META):
                    with open(META, encoding='utf-8') as f:
                        meta = json.load(f)
                meta.update(json.loads(body))
                with open(META, 'w', encoding='utf-8') as f:
                    json.dump(meta, f, ensure_ascii=False)
                print('采集完成 → ' + OUT, flush=True)
                self.server.result = 0
            elif kind == 'fail':
                print('采集失败：' + body.decode('utf-8', 'replace'), file=sys.stderr, flush=True)
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
    ap.add_argument('--clips', help='只拍这几段，逗号分隔；不给就全拍')
    ap.add_argument('--no-open', action='store_true', help='不自动打开浏览器')
    args = ap.parse_args()

    os.makedirs(FRAMES, exist_ok=True)
    srv = ThreadingHTTPServer(('127.0.0.1', args.port), partial(H, directory=ROOT))
    srv.result = None
    url = 'http://127.0.0.1:%d/capture.html' % args.port
    if args.clips:
        url += '?clips=' + args.clips
    print('采集页：' + url, flush=True)
    if not args.no_open:
        webbrowser.open(url)
    srv.serve_forever()
    sys.exit(srv.result or 0)
