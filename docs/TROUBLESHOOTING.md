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

### A fist does not fire

It has to be still. Arming needs 300ms without much palm movement, then the pose held for about
0.7s. A hand still travelling is read as a spin, deliberately - a moving hand's pose is not
trustworthy.

### The planet is fine but asteroids never appear

Survival mode only exists with the camera on, and the entrance is in the camera panel. Below 900px
wide the panel is hidden and the mode goes with it.

### The portrait never arrives

Generation is backgrounded and the page polls for up to twenty minutes - Gemini has been measured
at over ten. Check the server log: the run row carries only a code, while the real reason is logged.

### Everyone's portrait looks like the same picture

That is correct. You only see portraits your own browser generated; every other row shows a shared
placeholder, so no stranger's face is exposed.

### My own old runs show the placeholder too

Runs recorded before ownership tracking existed have no owner, so they are nobody's. They are not
lost - new runs attach to your browser normally.

### The leaderboard emptied itself

Almost always an ephemeral filesystem: a platform without a persistent disk resets `runs/` on every
redeploy. Mount a volume at `/app/runs`.

### Callsign taken, but it is my name

Callsigns are unique across the whole board, including names you used before. Pick a new one, or
clear the board if it is yours to clear.

### Caddy will not get a certificate

The domain's A record has to resolve to the droplet before Caddy asks, or the ACME challenge fails
and it retries with a backoff. `deploy/setup.sh` warns when the two disagree.

### The Docker image is enormous

The build context is the directory, not the git tree, so a gitignored-but-present file is still
copied. A stray screen recording once put 391MB in the image. Check `.dockerignore`.
