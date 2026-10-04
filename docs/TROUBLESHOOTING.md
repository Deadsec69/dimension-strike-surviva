# Troubleshooting

Symptoms in the order people actually hit them.

### The camera button does nothing / says HTTPS required

`getUserMedia` only runs in a secure context. `localhost` and `127.0.0.1` count; a bare IP or a plain
`http://` address does not - on an insecure origin Chrome does not merely refuse the call, it removes
`navigator.mediaDevices` entirely. The page still renders and the sandbox still works, but gestures,
survival mode, scoring and portraits are all unreachable, and the Start Survival button never appears
because it is gated behind an active camera.

**Which ports you expose decides this.** Automatic certificates need a challenge the CA can reach, and
both run on fixed ports: HTTP-01 on 80, TLS-ALPN-01 on 443. Neither can run on an arbitrary port, and
DNS-01 needs a DNS provider API that `sslip.io` does not offer.

| Exposed | URL | Gestures |
|---|---|---|
| 443 only (the committed setup) | `https://<dashed-ip>.sslip.io` | Yes |
| 8123 only, plain HTTP | `http://<ip>:8123` | No - sandbox only |
| 8123 only, self-signed certificate | `https://<ip>:8123` | Yes, after every visitor clicks through a full-page browser warning |
| 443 and 8123 | certificate issued on 443, served on 8123 | Yes, but that is two ports |

So a single port at 8123 means plain HTTP permanently. Use 443.

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
