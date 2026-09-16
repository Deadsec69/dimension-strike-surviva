#!/usr/bin/env python3
"""静态服务器。内置 http.server 不认 .mjs / .wasm 的 MIME，需补齐。"""
import sys, functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

SimpleHTTPRequestHandler.extensions_map.update({
    '.mjs': 'text/javascript',
    '.js': 'text/javascript',
    '.wasm': 'application/wasm',
    '.task': 'application/octet-stream',
})

class H(SimpleHTTPRequestHandler):
    def end_headers(self):
        # MediaPipe 的 GPU delegate 在部分浏览器下需要跨源隔离
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, fmt, *a):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % a))

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
