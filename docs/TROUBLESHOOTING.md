# Troubleshooting

Symptoms in the order people actually hit them.

### The camera button does nothing / says HTTPS required

`getUserMedia` only runs in a secure context. `localhost` counts; a bare IP or a plain `http://`
domain does not. On a deployment this means a real certificate, which means a real domain name.

### Gestures work but feel sluggish

MediaPipe is probably on the CPU. The GPU delegate needs cross-origin isolation, i.e. the COOP and
COEP headers. `serve.py` sets both; GitHub Pages cannot, so Pages is always the slower path.

### Pointing is unreliable

Hold the index finger straight up with the palm toward the camera and move your whole hand. The
crosshair follows the fingertip's position, not the direction it points, and tilting the finger toward
the camera shortens it enough to lose both the classifier and the geometric fallback at once.
