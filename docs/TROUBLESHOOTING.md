# Troubleshooting

Symptoms in the order people actually hit them.

### The camera button does nothing / says HTTPS required

`getUserMedia` only runs in a secure context. `localhost` counts; a bare IP or a plain `http://`
domain does not. On a deployment this means a real certificate, which means a real domain name.

### Gestures work but feel sluggish

MediaPipe is probably on the CPU. The GPU delegate needs cross-origin isolation, i.e. the COOP and
COEP headers. `serve.py` sets both; GitHub Pages cannot, so Pages is always the slower path.
