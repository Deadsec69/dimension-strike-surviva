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

### The leaderboard empties itself on App Platform

Expected there, not a bug. DigitalOcean App Platform containers have no persistent storage and do not
support volumes, so `runs/` - the board, the portraits and the free-credit ledger - is lost on every
deploy and on any container replacement. Either accept it, move storage to Spaces Object Storage, or
run the droplet setup in `deploy/`, which keeps `runs/` on a Docker volume.

### `/api/health` says `hasKey:false` on a deployed app, though I set the key

The usual cause on App Platform is that the spec was applied with `doctl apps update --spec
.do/app.yaml`. That replaces the whole spec, and the `SECRET` entries in the file carry no value on
purpose - a value there would be a secret in git - so applying it stores the *empty string* for both
and the key you set earlier is gone.

The giveaway is in the spec itself. Secrets come back as `EV[1:...]` ciphertext, so you cannot read
them, but you can compare their lengths:

```bash
doctl apps get <app-id> -o json \
  | jq -r '.[0].spec.services[].envs[] | select(.type=="SECRET") | "\(.key) \(.value|length)"'
```

Two secrets of *identical* length is the signature of identical plaintext - both empty. A real key and
a real token differ in length.

Fix it with `bash deploy/do-apply.sh`, which merges the values in from `.env` and never sends an empty
secret. Then confirm `hasKey:true` and `freeLeft:1` on `/api/health`.

### The CLEAR button never appears, even with the right token

`canClear` in `/api/health` does not mean "you may clear". It is
`(not ADMIN_TOKEN) and client_ip in (127.0.0.1, ::1)` - true only when *no* token is configured and
you are on loopback, i.e. the local-development case. Once `DS_ADMIN_TOKEN` is set it is always
`false`, for everyone, including a valid token holder.

That is not what reveals the button. `js/board.js` shows it when either a token is stored locally or
`canClear` is true:

```js
const show = !!this.adminToken() || this.canClear;
```

So the deployed path is the stored token, which `/?admin=<token>` writes to `localStorage` under
`ds.admin`. If the button is missing, the token is not in this browser's storage - visit
`/?admin=<token>` once more. The URL is stripped from the address bar afterwards, so re-running it
looks like nothing happened; check `localStorage.getItem('ds.admin')` in the console.

### Clearing the board returns 403 on a deployed app

The server compares `X-Admin-Token` against `DS_ADMIN_TOKEN` with a constant-time comparison, and both
failure modes answer the same `403 {"error":"not allowed"}` - a wrong token, and a right token sent to
a server where none is configured. So a 403 alone does not tell you which it is.

Separate them with `/api/health`: `hasKey` tells you whether the secrets landed at all. If the token is
genuinely stale, re-apply with `bash deploy/do-apply.sh` - it reuses the `DS_ADMIN_TOKEN` already in
`.env` rather than generating a new one, so the token you hold stays valid.

### I renamed the app and the URL still has the old name

Working as designed, and not fixable. App Platform derives the starter subdomain from the app's name
once, when the app is created, and pins it from then on. Renaming the app changes only what the
dashboard lists it under; there is no way to regenerate the subdomain, and the only route to a
different URL is creating a new app and redeploying into it.

Usually this is the behaviour you want, because it means a rename cannot break a link you have already
shared. It only hurts if you were counting on the name to fix a URL you dislike - decide that at
creation, which is the one moment the name has any effect on the hostname.

### Everyone gets a free portrait again after every deploy

The free-credit ledger is `runs/quota.json`, and on a platform with no persistent disk it is erased
along with the rest of `runs/` on each deploy. `DS_FREE_PORTRAITS` is "ever" only for as long as the
container lives.

So on App Platform the per-visitor limit is not the real protection - `DS_GLOBAL_PER_DAY` is, because
it is the only ceiling a redeploy cannot reset. If a link is circulating and you deploy often, that
number is what stands between it and your Gemini bill. Persist `runs/` (Spaces, or the droplet setup in
`deploy/`) if you need the per-visitor count to actually mean "ever".

### How do I turn an App Platform app off for a while?

You cannot. There is no pause, stop or deactivate - `doctl apps` offers `restart` and `delete` and
nothing in between. Scaling to nothing does not work either: a spec with `instance_count: 0` is
accepted and then silently coerced back to `1`, and `doctl apps propose` still returns the full
`app_cost`, so the attempt costs the same as leaving it up.

```bash
doctl apps spec get <app-id> | sed 's/instance_count: 1/instance_count: 0/' \
  | doctl apps propose --app <app-id> --spec - -o json | jq '.[0].spec.services[0].instance_count'
# -> 1
```

So the only way to stop the charge is `doctl apps delete <app-id>`, and that is not a pause - it
destroys the starter domain with the app. The hash in `<name>-<hash>.ondigitalocean.app` is assigned at
creation and is not recoverable, so recreating the app later gives a **different URL** and every link
already shared stops working. At $5/month, leaving it running costs about 17 cents a day; weigh that
against a dead link before deleting something you intend to bring back.

### Is the Gemini key reachable from the browser?

No, and the audit trail is worth keeping. The value leaves the process exactly once, to Google, as the
`x-goog-api-key` request header - a header rather than a URL, so it cannot land in a query string, a
referer or a proxy log. `/api/health` reports it as `bool(api_key())`, never the value. Both 500
handlers pass exception text through `scrub()` against the owner's key and the visitor's, and public
board rows carry short codes while the detail goes to stderr. `.dockerignore` excludes `.env`, so no
container has a file to read, and on App Platform the key is a `SECRET` env var that reads back only as
`EV[1:...]` ciphertext.

To re-audit rather than take the above on trust:

```bash
grep -n 'api_key()\|GEMINI_API_KEY' serve.py          # every use; line 82 is the only egress
curl -s "$URL/api/health"                             # expect "hasKey": true, no key material
curl -s -o /dev/null -w '%{http_code}\n' "$URL/%2Eenv"   # expect 404
```

Search git history by the key's **value**, not by a guessed prefix - Gemini keys are not all
`AIza...`; current ones look like `AQ.<...>`, and a pattern-based scan for the wrong prefix returns a
reassuring zero while proving nothing:

```bash
KEY=$(grep '^GEMINI_API_KEY=' .env | cut -d= -f2-)
git rev-list --objects --all | awk '{print $1}' \
  | git cat-file --batch-check='%(objectname) %(objecttype)' \
  | awk '$2=="blob"{print $1}' \
  | while read -r o; do git cat-file blob "$o" | grep -qF "$KEY" && echo "$o"; done
```

What *is* consumable is the key's quota, by design: a visitor without their own key spends
`DS_FREE_PORTRAITS` generations on yours. See `DS_GLOBAL_PER_DAY` - on an ephemeral filesystem it is
the only ceiling a redeploy does not reset.
