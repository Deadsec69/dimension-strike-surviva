# Dimensional Strike

> The camera panel's – / + collapses and expands the preview; the right panel yields to its height,
> so the board is always above it.
> CLEAR at the top right of the board clears it in two clicks (the second within 4 seconds), deleting
> the portrait files with it. Clicking the board title or any row opens the full-board modal, which
> has Export CSV. The board keeps only each callsign's best run (the Runs column is how many they
> have played); every run is still in `runs/leaderboard.json`.
> Callsigns are unique: a name already on the board can't start a run (it shows Callsign taken), with
> the sole exception of the one this browser last played under - that's you.
> Fist / open palm in survival mode: holding still arms it (300ms), and holding the pose for another
> 0.8s fires - no neutral gesture needed first.

Play a higher-dimensional civilization: control a planet's temperature and pressure and watch the
civilization on it rise and fall, or drop a dual-vector foil to flatten it into two dimensions, or
crush it with gravity. **The planet can be grabbed and turned like a globe** - drag horizontally to
spin it, vertically to tip it, and it coasts on inertia after you let go. Camera gesture input is
supported: **hold a fist still = gravity crush, hold an open palm still = dual-vector foil**; once
the verdict appears, **clap both hands** for the next specimen. With the camera on there is also
**survival mode**: asteroids fall on the planet ever more densely, you point your index finger to
shoot and hold a ✌️ to place shields, every impact raises the temperature and every shield raises
the pressure - see how long you can hold it.

A purely static site with no build step - clone it and open `index.html` through any server. Three.js with hand-written shaders, plus MediaPipe gesture
recognition.

The art direction is **photoreal**: a NASA base map underneath, with the effects of temperature and
pressure layered on procedurally - ice caps, desertification, oceans boiling dry and molten fissures,
each its own mask. The textures carry the material quality; the procedural layers keep the sliders
meaningful. Surface imagery from [Solar System Scope](https://www.solarsystemscope.com/textures/),
licensed CC BY 4.0 and credited in the page.

## Documentation

| | |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the pieces fit, and where each one runs |
| [docs/API.md](docs/API.md) | Every HTTP endpoint and the warning codes |
| [docs/CONFIG.md](docs/CONFIG.md) | Every environment variable |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptoms, in the order people hit them |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | Terms the comments assume |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Conventions, testing, secrets, privacy |

## Quick start

```bash
bash fetch-assets.sh && python serve.py 8123
```

Open http://localhost:8123 . `localhost` counts as a secure context, so the camera works without a
certificate - which is not true of a bare IP on your network, so test gestures locally rather than from
another device.

This repo commits the binary artifacts (`models/`, `vendor/wasm/`, `textures/`), so a clone runs as
is and `fetch-assets.sh` can be skipped. What it fetches (about 20MB in total) is those artifacts:
the MediaPipe WASM runtime and the gesture recognition model. The script is idempotent and skips
anything already present. **The page opens without it** - the planet, the sliders and both strike
effects all work; only the camera gestures report "Unavailable".

## Live

**https://mr-salticidae.github.io/dimension-strike/**

GitHub Pages, the root of the `gh-pages` branch, with HTTPS enforced (so the camera works). To update
the site:

```bash
bash fetch-assets.sh && bash deploy.sh
```

`deploy.sh` pushes the current directory along with the binary artifacts to `gh-pages` - those files
used to be excluded from main by `.gitignore`, and Pages has no build step that could run
`fetch-assets.sh`, so the deploy branch has to carry them.

Pages handles points 1 and 3 below by itself: `.js`/`.mjs` come back as `text/javascript`, `.wasm` as
`application/wasm`, and gzip is on by default (the 9.5MB WASM transfers as 2.9MB). The one thing it
cannot do is custom response headers, so the COOP/COEP cross-origin isolation pair is missing and
MediaPipe falls back to XNNPACK rather than the GPU delegate - gesture recognition still works, it
just runs on the CPU.

**Pages is the game only.** It is a static host, so there is no `/api/` behind it: no leaderboard, no
portraits and no scoring service. The whole of survival mode that happens in the browser works, and
everything that needs the server does not. For the full thing - board, portraits, free credit - the
site has to be served by `serve.py`, which is what the deployment sections below are about. The
instance running from this repository is:

**https://dimension-strike-qsn3g.ondigitalocean.app** - DigitalOcean App Platform, `basic-xxs`, $5/mo.

Its app is named `experimental` in the DigitalOcean dashboard; the hostname keeps the name the app was
created under, because App Platform pins the starter domain at creation. The board there is wiped by
every deploy - that platform has no persistent disk.

## Deploy it publicly

The game already runs entirely on the visitor's machine - Three.js and MediaPipe use their GPU, CPU and
camera, and the server does nothing for gameplay. It only serves the files (with the COOP/COEP headers
that let MediaPipe use the GPU delegate) and makes about two Gemini calls per finished run.

**Whose key pays.** Per run, in order:

1. The **visitor's own key**, if they typed one into the optional field in the camera panel. It lives in
   their browser, is sent only to this app's `/api/finish`, and is used for that request alone - never
   logged, never written to `runs/`, never echoed back.
2. Otherwise **your key**, while that visitor still has free credit (`DS_FREE_PORTRAITS`, default 1).
3. Otherwise **no call at all**: the run still scores and the board still records it, and only the
   portrait degrades to their raw snapshot tinted by tier.

Your key stays in the server environment and is never sent to a browser in any of those branches.

**You only ever see your own portraits.** A portrait is a likeness of a real person's face, so the
board hands out the real image only to the browser that generated it (matched on the same `ds_uid`
cookie). Every other row shows `assets/portrait-placeholder.jpg` instead, so the leaderboard still reads
as a full ranking without exposing anyone. Enforcement is server-side, not cosmetic:

- portraits are written to `runs/<callsign>/<time>_<tier>_<random>.jpg`, one folder per player;
- `runs/` is **not** served as static files at all - a direct URL 404s;
- `/api/portrait/<run id>` is the only way to fetch one, and it checks the cookie before reading the
  file, so a guessed or shared link gets nothing;
- the owning `uid` is never included in any response.

Runs recorded before this existed have no owner, so they show the placeholder to everybody including
you - they are not lost, just no longer attributable to a browser.

**Metering.** An HttpOnly `ds_uid` cookie is the visitor's identity, with a hashed IP + user-agent
bucket behind it (`DS_FP_PER_DAY`) so clearing cookies doesn't mint unlimited free portraits, plus a
global daily ceiling (`DS_GLOBAL_PER_DAY`) and a per-IP request rate (`DS_RUNS_PER_HOUR`). The raw IP is
never stored, only a truncated hash. Be honest with yourself about what this is: deterrence, not
enforcement. A fresh browser, incognito or a VPN earns another free generation. Real enforcement needs
accounts. Heavier fingerprinting (canvas, fonts) is deliberately not used - privacy-hostile and still
unreliable.

**Clearing the board is privileged.** It deletes every run and every portrait file, so it is never
open to the world. `DS_ADMIN_TOKEN` set (as it is on Render, generated) means only a request carrying
that token may clear, and the buttons stay hidden for everyone else. With no token set the server is
assumed to be local and only loopback may clear - so nothing changes while you develop.

### Deploying on DigitalOcean App Platform (no domain, nothing but DigitalOcean)

The shortest path to a working public link. App Platform assigns a starter domain on
`ondigitalocean.app` and issues a real certificate for it, so the site is HTTPS from the first deploy -
which is the part that matters, because `getUserMedia` only runs in a secure context and without it the
camera never starts.

1. DigitalOcean → **Apps → Create App** → pick this repo. It reads [`.do/app.yaml`](.do/app.yaml).
2. Set `GEMINI_API_KEY` and `DS_ADMIN_TOKEN` when prompted. They are declared `SECRET`, so they are
   stored encrypted and never committed. Generate the token with `openssl rand -hex 24`.
3. Deploy. You get `https://<app>-<hash>.ondigitalocean.app`, with the hash assigned by
   DigitalOcean. See the note on renaming below before you pick a name you care about.
4. Visit `/?admin=<token>` once to reveal the board's CLEAR control.

No domain, no DNS, no certificate management, no Caddy.

**Deploys are deliberate, not automatic.** The spec uses a plain `git` source rather than the GitHub
integration, for two reasons: it needs no OAuth authorization, so the app can be created entirely from
the CLI; and it has no `deploy_on_push`. That second one is the point - App Platform has no persistent
storage, so an automatic deploy on every push would silently wipe the leaderboard and the portraits.
Deploy when you mean to:

```bash
doctl apps create-deployment <app-id>
```

**Never apply the spec file directly.** `doctl apps update --spec .do/app.yaml` replaces the *whole*
spec, and the two `SECRET` entries in it carry no value - a value there would be a secret committed to
git. So applying it stores the empty string for both, and the site comes up with `hasKey:false`:
portraits refused, board unclearable. Use the wrapper instead, which merges the real values in from
`.env` and pipes the result to `doctl` on stdin, so the merged spec never touches disk:

```bash
bash deploy/do-apply.sh            # app id from $DS_APP_ID in .env, or pass it as an argument
DS_UPDATE_SOURCES=1 bash deploy/do-apply.sh   # also rebuild from the git branch
```

It generates `DS_ADMIN_TOKEN` on first run and appends it to `.env` so it stays stable across applies.
A key that is missing from `.env` is left out of the spec entirely rather than sent as an empty secret.

**The app name is not the hostname, and renaming cannot move it.** App Platform derives the starter
subdomain from the app's name once, when the app is created, and then pins it. Renaming the app leaves
the old prefix in place, and there is no way to regenerate the subdomain - the only way to a different
URL is a new app. So this app is named `experimental` in the dashboard while still answering on
`dimension-strike-qsn3g.ondigitalocean.app`, the name it was created under. That is the useful
direction of the constraint: a rename is safe for a link you have already shared. The direction that
bites is the other one - choose the name carefully at creation, because that is the only moment it
decides anything.

**Cost: $5/month.** One `basic-xxs` instance (1 shared vCPU, 512MB), which is what `.do/app.yaml`
asks for and is enough - the server only serves files and makes about two Gemini calls per finished
run; the game itself runs on the visitor's machine. Billed hourly and prorated, so a partial month
costs less. Confirm the current price rather than trusting this line:

```bash
doctl apps tier instance-size list          # basic-xxs -> $/month
doctl apps propose --app <app-id> --spec .do/app.yaml -o json | jq .app_cost
```

Not included: outbound bandwidth above the plan allowance, and Gemini usage, which Google bills to
whoever owns the key. `instance_count` stays at 1 on purpose - the board is a JSON file guarded by an
in-process lock, so a second instance would have its own copy and its own lock.

**Bringing it back after a delete.** The committed spec is a complete recreate source - it was
diffed against the live app's spec before that app was deleted, and the only difference was the
`ingress` block, which App Platform generates from `http_port`. So two commands:

```bash
doctl apps create --spec .do/app.yaml        # prints the new app id
bash deploy/do-apply.sh <new-app-id>         # merges the secrets in from .env
```

Then `doctl apps list-deployments <id>` until the phase is `ACTIVE`, and check `/api/health` reports
`hasKey:true` and `freeLeft:1`. Add the new id to `.env` as `DS_APP_ID` so later applies need no
argument. The second command is not optional: created from the spec alone, the app comes up with both
secrets set to the empty string and refuses every portrait.

**The URL will be different.** The starter domain's hash is assigned at creation and cannot be carried
over, so a recreated app is reachable at a new `<name>-<hash>.ondigitalocean.app` and any previously
shared link stays dead. If a stable address matters, point a domain you control at the app and share
that instead - then the generated hostname never appears in a link.

**Operating it.** Everything is `doctl`, and none of these redeploy:

```bash
doctl apps logs <app-id> --follow            # runtime logs; --type build for a failed build
doctl apps logs <app-id> --type build
doctl apps list-deployments <app-id>         # phase per deployment: BUILDING / ACTIVE / ERROR
doctl apps restart <app-id>                  # same image, fresh container - and so a fresh empty runs/
doctl apps get <app-id>                      # name, default_ingress, active deployment
```

`restart` is worth a caveat: it does not rebuild, but it does replace the container, so it resets
`runs/` exactly as a deploy does. There is no pause or stop - see
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for why scaling to zero is not one either.

**The trade-off, in DigitalOcean's own words:** App Platform containers *"do not provide persistent data
storage"* and *"do not support volumes"*, and the local filesystem is *"permanently lost after
deployments and other container replacements"*. `runs/` holds `leaderboard.json`, `quota.json` and every
portrait, so **the leaderboard, the portraits and everyone's free-portrait credit reset on each
deploy**. Good for a demo link; if the board is meant to accumulate, use Spaces Object Storage or the
droplet below, which keeps everything on its own disk.

### Deploying on a DigitalOcean droplet

A $6/mo droplet, Docker, and Caddy for automatic HTTPS. The droplet's own disk is what keeps the board,
the portraits and the free-credit ledger across restarts.

**No domain required, but HTTPS is.** `getUserMedia` refuses to run over plain `http://`, so an
IP-only deployment would have no camera and therefore no game. A bare IP also cannot hold a publicly
trusted certificate. The way out is `sslip.io`: it resolves `134-209-17-42.sslip.io` to
`134.209.17.42`, so the hostname *is* the address - nothing to register, nothing to point - while still
being a real name, which is what allows a real certificate.

Leave `DOMAIN` blank and `setup.sh` derives it from the droplet's own IP. Set it only if you would
rather use a domain you own.

**It has to be 443.** Certificate issuance needs a challenge on a fixed port - HTTP-01 on 80 or
TLS-ALPN-01 on 443 - so exposing some other port like 8123 instead means plain HTTP forever, and plain
HTTP means the browser blocks the camera and the whole gesture half of the game is unreachable.

**One public port.** Only 443 is published. The ACME HTTP challenge wants port 80, so Caddy falls back
to TLS-ALPN-01 over 443 instead. The trade-off is that `http://` does not redirect, so share the
`https://` URL. SSH obviously stays open, or you lose the droplet.

```bash
# on the droplet, as root
git clone https://github.com/Deadsec69/dimension-strike-surviva.git /opt/dimension-strike
cd /opt/dimension-strike/deploy
cp .env.example .env && nano .env          # GEMINI_API_KEY and DS_ADMIN_TOKEN; leave DOMAIN blank
bash setup.sh                              # installs Docker, opens 443, builds and starts
```

It prints the URL to share, e.g. `https://134-209-17-42.sslip.io`.

One caveat worth knowing: `sslip.io` is not on the Public Suffix List, so every certificate issued for
it counts against a single shared Let's Encrypt rate limit. Caddy falls back to ZeroSSL automatically
if that is exhausted, and pointing a domain you own at the droplet avoids the issue entirely.

`setup.sh` is idempotent, so re-run it after a `git pull` to deploy a new version. To update by hand:
`docker compose up -d --build`.

**Secrets never touch git.** `deploy/.env` is gitignored and exists only on the droplet;
`deploy/.env.example` carries blank values. Generate the admin token with `openssl rand -hex 24`, then
visit `https://<your domain>/?admin=<token>` once to reveal the board's CLEAR control.

The `runs` volume is the one piece of state. It survives `docker compose down`, a rebuild and a reboot;
deleting it resets the leaderboard, every portrait and everyone's free credit. Back it up with
`docker run --rm -v dimension-strike_runs:/r -v "$PWD":/b alpine tar czf /b/runs-backup.tgz -C /r .`

### Deploying on Render

`render.yaml` is a blueprint, so the service, the disk and the environment come from the repo. Any
container host works the same way; the Dockerfile is plain.

1. Push to GitHub (Render reads the blueprint from the repo).
2. Render → **New → Blueprint** → pick this repo. It reads `render.yaml` and proposes a web service
   with a 1GB disk mounted at `/app/runs`.
3. Set **`GEMINI_API_KEY`** when prompted - it is `sync: false`, so it is never committed. Leave it
   blank and the board still records every run; portraits simply stay empty.
4. Apply. The first build takes a few minutes (it clones the repo and builds the image).
5. In the dashboard, copy the generated **`DS_ADMIN_TOKEN`**.
6. Visit `https://<your-service>.onrender.com/?admin=<that token>` once. The token is stored in that
   browser, stripped from the URL immediately, and the board's CLEAR controls appear for you alone.

Tune the free allowance with `DS_FREE_PORTRAITS`, `DS_FP_PER_DAY`, `DS_GLOBAL_PER_DAY` and
`DS_RUNS_PER_HOUR` from the same dashboard; they take effect on restart.

Three things that will bite you otherwise:

- **Keep the persistent disk at `/app/runs`.** It holds `leaderboard.json`, the portraits and
  `quota.json`. Without one, every redeploy wipes the board and hands everyone a fresh free portrait.
  Render's free tier has no disks and sleeps when idle, which is why the blueprint asks for Starter.
- **`runs/` is excluded from the image** by `.dockerignore`. The portraits committed to this repo are
  photographs of real people; publishing them at a public URL is not something to do by accident.
- **The build context is the directory, not the git tree.** A gitignored-but-present file still gets
  copied unless `.dockerignore` lists it - a stray screen recording once put 391MB into the image.

HTTPS is mandatory for the camera, and every one of these hosts provides it. Locally nothing changes:
`python serve.py 8123` still binds loopback, and the server only listens on `0.0.0.0` when `PORT` is set.

## Deploying elsewhere

Copy the whole directory to any web server. Three things have to be right:

**1. HTTPS is required.** `getUserMedia` only works in a secure context. Over plain HTTP the page
still renders and the sliders and buttons work, but the browser refuses the camera outright (the page
shows "HTTPS required").

**2. The binary dependencies are in the repo.** `models/*.task`, `vendor/wasm/` and `textures/` come
with it; if any are missing, run `bash fetch-assets.sh` once (it is idempotent).

**3. MIME types have to be right.** If `.mjs` and `.wasm` come back with the wrong type, ES module
imports and WASM instantiation both fail silently. An nginx reference config:

```nginx
types {
    text/javascript   js mjs;
    application/wasm  wasm;
}

gzip on;
gzip_types text/javascript application/wasm application/json text/css;
gzip_min_length 1024;
# .task is itself a zip, so compressing it again gains nothing
gzip_proxied any;

# Optional: cross-origin isolation for MediaPipe's GPU delegate
add_header Cross-Origin-Opener-Policy   same-origin;
add_header Cross-Origin-Embedder-Policy credentialless;
```

## Size

| Stage | Transferred | Notes |
|---|---|---|
| First paint | **1.3 MB** | Three.js plus the page code; the planet is playable immediately |
| After "Turn on camera" | +19 MB | 9.5MB MediaPipe runtime plus an 8.4MB model |

The gesture module goes through a dynamic `import()`, so visitors who never turn the camera on never
download those 19MB. That split is the single biggest thing keeping the first paint small. The WASM is about 3MB gzipped - make sure compression is on.

## Browser support

Chromium and Safari are the tested targets; Firefox renders the planet but its MediaPipe support is
less reliable. The hard requirements are WebGL2, ES modules, and a secure context for the camera. A
phone will render the planet, but survival mode is hidden below 900px because the camera panel is.

## Code layout

```
index.html          HUD structure
css/style.css       console styling. Color narrative: amber = the civilization, cold blue = the observer
js/planet.js        the Three.js scene and every shader (planet / atmosphere / clouds / foil / core)
js/civ.js           the civilization's state evolution and comms log
js/gesture.js       MediaPipe GestureRecognizer wrapper: recognition state machine, charging, clap, the survival crosshair
js/survival.js      survival mode: asteroids, shields, beams, dwell aiming, the temperature/pressure model (loaded on demand)
js/board.js         survival scoring: snapshot, submission, portrait and the observer board (degrades when there is no server)
js/main.js          wiring and the main loop
vendor/             Three.js (committed), the MediaPipe runtime (fetched by fetch-assets.sh)
models/             the gesture model (fetched by fetch-assets.sh)
serve.py            development server. Fills in the .mjs / .wasm MIME types, and serves /api/finish and friends (see "Survival scoring")
runs/               generated observer portraits and leaderboard.json (committed in this repo)
.env.example        template for GEMINI_API_KEY; copy to .env (not committed)
tools/promo-gif/    promo GIFs: frame-by-frame capture -> HUD overlays -> encode (see its own README; not deployed with the site)
```

## Performance

The planet shader runs twice a frame (colour, then the self-rendered depth map), on top of a 16-sample
depth of field and five bloom levels. That is why the DPR is capped at 1.5 and then adapted from the
measured frame interval, stepping down after a second above 22ms and back up after six below 13ms.

If it still struggles, the post chain is where the time goes - bloom levels and depth-of-field samples
before anything in the surface shader.

## Implementation notes

A few traps already fallen into. Read these before changing things.

**The sliders lagging your hand is deliberate.** Drag the temperature to 150K and the ice cap takes
a dozen seconds to spread - `ENV_TAU` gives the ice, oceans, vegetation, rock, clouds and atmosphere
each their own time constant, and the slider only sets a target. The approach uses `1-exp(-dt/tau)`
rather than a fixed-ratio lerp; the latter means "cover 10% of the remainder each frame", which
jitters at 144Hz and feels sticky at 30Hz. Zero-latency response gives away faster than any texture
problem that this is not a simulation, so don't fix that lag as if it were a bug.

**Shattering is impulse and integration, not interpolated positions.** If the displacement is driven
by `smoothstep(progress)`, the derivative goes to zero at both ends and a whole field of fragments
starts and stops together. Now each piece has its own fracture time, steps its velocity when it
breaks, and in vacuum no longer decays - only reduced by the quadratic term of the remnant core's
gravity, so slow ones fall back and fast ones never return. The fragments don't stop on the frame the
animation "ends" either: the `done` state keeps integrating to 1.8.

**Any effect that only changes albedo reads as a sticker.** The temperature sections were all
`base = mix(base, color, mask)` at first, sharing one lighting model - ice, sand and magma being the
same substance under the light, so however accurate the palette, it looked like an image pasted onto
a sphere. Making "the whole planet is changing" work takes four things, and missing any one of them
gives it away:

1. **The normal has to change.** Base terrain takes its gradient straight from the base map (that is
   real imagery, the mountain ranges are already in it, and covering a continent in noise just makes
   sandpaper); procedural relief only appears once the material has genuinely changed - snow ridges
   coarse and gentle, dunes and lava slopes fine and dense. Slopes growing out of the terminator are
   what make a material hold up.
2. **How the material responds to light has to change.** Water is a very tight specular point; ice
   has a much wider lobe and **blue shadows** (multiple scattering inside the ice eats the red end)
   and scatters light sideways as well; sand has an opposition effect, backscattering most strongly
   when the view and light directions nearly coincide.
3. **There has to be a term that ignores day and night.** Thermal radiation is visible as dark red
   from about 645K. It treats the lit and unlit hemispheres alike, so once it is hot enough **the
   entire night side burns** rather than just the fissures - the most direct line between "the whole
   planet" and "one layer".
4. **The atmosphere has to know what the surface is doing.** Density can't listen to pressure alone:
   a dry surface raises dust, a boiling sea raises steam, a frozen one has its gases condense onto the
   ground, and a burning one loads aerosols. Without that coupling the halo at the limb never moves,
   whatever the surface does. Note that dust has to peak in the desert temperature band and retreat
   before melting - extrapolated linearly it would still be at full strength at eight hundred degrees,
   pushing the whole atmosphere into an orange glow that smears the surface away.

**Zonal cloud advection: the offset must be constant per band.** The cloud layer used to be one
texture translating at a fixed rate - a rigid body. Converting it to zonal wind bands (trades 0-30
degrees blowing east to west, westerlies 30-60 reversing, polar easterlies turning west again) went
wrong twice, and the second attempt looked worse than the first. Both are worth recording:

*First attempt*: let the UV offset **vary continuously** with latitude and accumulate without bound.
Neighbouring latitudes' sample points get dragged further and further apart, the derivatives the
sampler sees explode, automatic mip selection jumps to a level tens of pixels wide, and the whole deck
smears to grey - it looks like the clouds disappeared.

*Second attempt* (the wrong compromise): **slow oscillating shear plus an in-place deformation field**.
The oscillation slid the clouds back and forth while the field twisted each mass in place - that is
not movement, it is procedural deformation, and it is recognizable at a glance. **The primary motion
of clouds is translation**, and trading translation away for anything else is wrong.

*The right answer*: make the offset **constant within a band**. A constant offset has zero UV
derivative, so it can accumulate arbitrarily far without blurring, and within a band it is rigid
translation - exactly the motion clouds should have. Each of the three bands samples the texture once
and they are blended by `bandWeights()`; the blend ring between bands reads precisely as the turbulent
mixing inside a wind shear layer, which is physically what is there: two opposing flows stirring.
The modulation field for formation and dissipation has to be rigidly advected per band as well, or
you get "a stationary pattern laid over moving clouds", which is worse than having none.

The rate has to be held down: the surface rotates at 0.0088 UV/s, while real jet streams are only a
few percent of the equatorial rotation speed. Clouds moving faster than the planet turns reads as
"the clouds are being yanked"; this puts the westerlies at about five minutes for a full circuit.
Cloud cover is banded separately by `cloudBand()`: the intertropical convergence zone (whose real
center is near 6N) is thickest, the subtropical descending branch thinnest, and the mid-latitude storm
track rises again. The weight is small, because this cloud map is real observation and already
contains that climatology.

**Fires hang off "thermal shock", and thermal shock is a by-product of the damped ramp.** There is no
need to track a rate of change separately: the gap between the target temperature and the vegetation
channel (tau=1.8) is exactly that - ease the slider along and the gap stays near zero, yank it up and
it spikes, then falls back as the slow channel catches up. What burns is precisely the part of the
biosphere that could not keep up. A fire line needs the zero crossing of the noise (its ridge) to be
a continuous front; raising the noise to a high power directly gives sparse isolated points, too dim
to see at all. Smoke drags downwind: sampling the fire intensity upwind gives "the smoke here was
made over there", and the sign of the wind comes from `zonalWind()` automatically. Burned area
`uBurn` is integrated on the JS side: it grows while burning and fades with tau≈22 seconds once the
vegetation recovers.

**Crustal activity is located by the difference between two temperature channels.** The lithosphere
channel (tau=8) is slower than the ice channel (tau=4), so evaluating the same ice function on both
and taking the difference gives **the ring the ice has just retreated from**. Ice unloading -> upper
crust rebounds and depressurizes -> decompression melting; after the last deglaciation Iceland erupted
at 30-50 times today's rate for over a thousand years, so that ring lights up with volcanism. The
fissures must take their own, **much narrower** ridge: the factor 1.7 in `ridge` was tuned for the
magma sea and is so wide it is positive almost everywhere, and no exponent can hold that back - the
same noise value has to be re-evaluated with a different factor.

**The planet is three layers, not one shell.** With only the shell breaking apart and nothing inside,
it reads as a balloon. The crust (r=1), mantle (r=0.86) and core (r=0.40) each have their own fracture
window: `uFracWin` makes the mantle break later than the crust, `uBurstK` makes it fly slower, and
`coarse` in `_fracture(geo, coarse)` makes it break into larger pieces - denser the further in. The
core never fractures at all; it is compressed, lit up, and left behind as an ember.

The core is also **the light source for the fragments' inner faces** (`uCoreGlow`, falling off with
the inverse square). "There is something inside" mostly stands on that light: without it, a broken
planet is just a skin blown apart. The mantle and core are normally `visible = false` and only switch
on inside `triggerCrush()` - an intact sphere is opaque, rendering a layer nobody can see is
pointless, and the foil path never needs them.

**Fragments are pieces, not faces.** One triangle used to be one fragment: twenty thousand identical
pieces each flying off on their own, and no amount of tuning the scatter parameters could make that
anything but confetti. Now Worley (a grid with jittered seeds, taking the nearest - equivalent to
Voronoi but only checking 27 neighbouring cells instead of comparing against thousands of seeds)
groups the faces into about two thousand fragments, with two grid densities selected by a
low-frequency noise, so some regions split into large plates and others crumble to grit. A fragment's
face count is the mass proxy: **under the same impulse a small piece flies faster and spins harder**
while a large one is slow and steady - binding the size spectrum and the speed spectrum together.

**The shading normal has to turn with the fragment.** This is the number one reason fragments look
fake: `vSurf` is the undeformed sphere direction, and shading used to use it too, so a tumbling
fragment's light and shade never moved and it looked like a sheet of paper with an image on it. Now
it is two paths - `vSurf` still drives surface properties (ice by latitude, lava by noise, which must
not turn or the texture would slide), while `vNrm` follows the fragment's rotation and drives shading
alone. Only then do fragments flash light and dark as they tumble.

**The material only switches to DoubleSide during the shatter.** Under `FrontSide` a thin triangle
turning over is culled outright, and a field of fragments blinks in and out - which is worse than
"like confetti", it isn't even a solid. The back face is rendered as a fracture surface: freshly
exposed mantle, no land or sea, no clouds, just rock and the heat brought up from the center, with the
heat applied to that face only (brushed evenly over every face, two thousand fragments turn into
orange leaves together). An intact sphere is closed, so it is switched on in `triggerCrush()` and back
in `reset()`, never paying for twice the fragment shading the rest of the time.

**The fracture needs a pause.** The most important thing in those 2.7 seconds is the instant it
breaks, and sliding through it at a constant rate is the same as it not happening. Hit-stop compresses
scene time to 0.14x, holds for 130ms and releases over 240ms; camera shake runs on real time, so the
image keeps shaking through the pause. The flash hangs off the `onShock` callback rather than a
hardcoded delay - time has been stretched, and a hardcoded one is guaranteed to drift out of sync.

**The foil is horizontal, because the plane it lies in is the one the planet collapses into.** It
used to be a vertical quad sweeping sideways while the result was a horizontal disc - the blade and
the cut plane 90 degrees apart, something no amount of brightness tuning can rescue; it simply looked
like a vertical beam next to a horizontal pancake. Now it lies at `y ~= 0` (0.06 above the sheet to
avoid coplanar fighting), its leading edge advances along X, and it is coplanar with the flattened
sheet; the part of the leading edge inside the planet is occluded by the unconverted hemisphere and
the sheet emerges from under the folds, which is exactly the occlusion it should have. `depthTest` has
to stay on - without it the foil draws over everything, which is the most direct difference between
"a streak of light stuck on the image" and "an object in the scene".

**The foil itself barely emits; the light comes from the planet's surface.** The real light is the
collapse front in `PLANET_FRAG`: it takes the peak of `vFlat`'s transition band, so it grows on the
sphere, follows its curvature, and is wherever the flattening has reached.

**The difference between intense blue light and white light is channel ratio, not brightness.** The
front's red channel is held below 1 (`vec3(0.12, 0.42, 1.00)`). With all three channels over 1, ACES
compresses everything to white and more brightness only gives a whiter blob - an earlier version was
`(0.88, 1.72, 2.60)` and looked like cheap over-exposure.

**Replaying is called "Next specimen", not "Restart".** The number counts up from 3,241 and each new
one skips a few - those belong to someone else and never appear; the star name is randomized while
the biology and era never change. **To an observer they are interchangeable anyway**, which reads
colder than inventing a backstory for each, and it makes replaying part of the premise: you are not
retrying, you are processing the next one. The exit sits directly under the verdict, because that is
where you are looking when it ends; the "Reset parameters" button in the left panel is a mid-run
reset, and the two are not the same thing.

It can also end without you acting. Twisting the parameters to an extreme until they wear out on
their own used to have no ending and no exit, leaving an empty planet - it now gets a verdict too:
"No weapon was used." While the verdict is up the camera watches for exactly one thing: **a clap**,
the second exit to the next specimen (see "Clap for the next specimen" below).

**Gesture spinning doesn't take up a new pose.** A fist and an open palm are weapons, and
**every other pose is a spin**: a hand in frame that isn't commanding anything is pushing the planet.
Not designating a specific "spin gesture" means there is nothing to learn first. Further:
**a moving hand is always a spin, whatever its shape** - while it moves fast the pose itself can't be
trusted, and only a fist or palm that has come to rest counts as a command. The palm center is the
mean of the wrist and four knuckles, steadier than any single point; it is filtered (see "One-Euro")
with a very small dead zone after that. x must be negated - the preview is mirrored with `scaleX(-1)`
while the landmarks are raw image coordinates, and without the flip a hand moving right would spin the
planet left. Spinning goes through **exactly the same** path as the mouse (`grab / dragBy / release`),
so inertia, the flick speed cap and the lockout during a strike are all inherited; the pointer has
priority, so while someone is actually dragging the camera doesn't fight them for the planet - and
weapons the same way, with `canFire()` false during a pointer drag. No spin starts within 250ms of a
weapon pose ending: the fist-to-palm transition frames read as None, and None means spin, so without
that guard every unclenched fist would nudge the planet. A hand returning within 600ms of flicking out
of frame has to hold still for 150ms to count as "catching" it, and a hand drifting back doesn't grab
- otherwise a spin you just flicked would be casually stopped by the hand coming back.

**Recognition is a state machine, and the classes have hysteresis.** Feeding single-frame
classifications straight in breaks three ways: a held pose makes the confidence flicker across the
threshold; the fist-to-palm transition frames read as None; and a fast-moving hand's pose is
untrustworthy. So: enter at 0.62, and leave only after 120ms continuously below 0.45; **the None score
is ignored** (it isn't calibrated for anything - a half-closed hand can read None 0.5 / Closed_Fist
0.45), each weapon class's score is read by name, and both have to be below 0.30 to count as
"genuinely not commanding"; and palm landmarks within 4% of the frame edge never count as a weapon -
a half-cropped hand is the number one source of false Closed_Fist. Fast movement disarms, and
**rearming = relaxed and still for 300ms plus a 250ms cooldown**, regardless of whether the hand ever
left the frame: leaving is a pause, not a reset (it used to require the hand to leave before firing
again, which forced people to reach outside the tracking area). A hand that has just entered is never
armed, so coming in with a fist already clenched does nothing. Tracking loss under 100ms leaves the
charge and armed state untouched, riding out a few dropped frames; position filtering resets on every
loss, so the frame it returns on emits no displacement. All timing runs on an internal clock
(accumulated per frame, each step capped at 100ms): not frame counts - in a dim room the camera drops
to 15fps and every frame-counted timer doubles; and not raw `performance.now()` deltas - switching
away from the tab and back jumps several seconds and fires a held fist on the spot.

**A weapon has to be held to fire, not merely posed.** 0.7 seconds for a fist, 0.6 for a palm, with a
100ms quiet period in front so two or three misclassified frames never reach the planet. The planet
reacts while a fist charges: the camera shakes slightly as the charge rises and the crustal fissures
light up with `uCharge` - both reusing existing systems (`trauma` and that ridge in `PLANET_FRAG`),
with the atmosphere left out. The glow is **not folded into `rift`**: that one is held back by
`(1-melt)` and the province mask, so folding it in would light only a few volcanic provinces and
nothing at all on a molten planet. An external force tears at the whole crust, so it gets its own term
on an unprovinced ridge. That ridge is far denser than rift's, so its factor can only be 1.2 - at full
charge it just crosses the bloom threshold and the fissures read as bright lines; at 2.4 whole
continents blow out to white blobs and smear the surface away, exactly the over-exposure the
"Rendering pipeline" section warns about. Over water it is held to 15%: orange over blue goes purple.
The glow is squared and the shake is linear: the shake has been rising from the start while the glow
only arrives in the second half, giving two stages. The 0.18 shake peak sits below the crush's
collapse phase (0.10 -> 0.30), so the moment it fires the shake only increases, reading as
0.18 -> 0.30 -> 1.0; set higher it would drop on the frame it fires. Releasing or moving mid-charge
aborts, and the accumulated amount decays with tau≈0.4s rather than vanishing; a score dipping into
the hysteresis band is a pause, not an abort - releasing at 85% must not be carried to 100% by that
120ms exit delay. The foil has no charge to show: a two-dimensional weapon has no "building up", only
a percentage on the status tag. Changing specimen, resetting and the verdict appearing all call
`interrupt()`: the fist is usually still clenched at that moment, and without it the strike would land
on the new specimen 0.3 seconds later. Charging runs on real time like the handling does, only applies
while `idle`, and is cleared by `reset()`.

**The palm is filtered with One-Euro, not a fixed-ratio EMA.** An EMA has one knob: tight enough to
kill the jitter means too slow to follow the hand. One-Euro's cutoff rises with speed - 1.2Hz at rest
filters the shake away, and a sweep pushes the cutoff up for near-zero latency. Beta is in Hz per
(unit/s): the 0.02-0.05 in the literature is tuned for pixel speeds, and here the coordinates are
normalized (speeds about 1/640 of pixel speeds), so beta has to be around 20 to mean the same thing.
The filter's dt is the difference of `video.currentTime` (the real sampling interval) while the
recognizer's timestamps stay on `performance.now()` (which must be monotonic within one image, and
`currentTime` resets when the stream changes) - don't mix them. The speed used for thresholds gets its
own tau=60ms low-pass, because the filter's own 1Hz derivative lags too much; the "fast" used for
disarming reads raw speed, since it has to take effect on the first fast frame.

**Release speed is the peak of the last 90ms, and only used while the hand is still moving.** A
release is always detected late: as the hand opens, tracking drops first and the classification
changes after, so by the frame `release()` runs the speed estimate is already falling. `_input` keeps
a 90ms ring buffer of angular velocity and the release takes the largest sample by absolute value -
but only while the current speed is still at least 35% of that peak: dragging, stopping, then letting
go is "putting it down", not "flicking it". Spin only, never tilt: tilt has a hard limit and clears
its speed on reaching it, so a peak there is just a bump against the boundary. This also fixed the
speed estimate itself: a 30fps camera in a 60Hz loop only moves on alternate frames, so approaching
`dx/dt` per frame sees alternating double-spikes and zeros, wobbling within +/-15% at steady state
(+/-25% at 144Hz), and which frame the release lands on is pure luck. It is now estimated over the
real interval since the last input, decaying toward zero only after input has stopped for 45ms - a
mouse has an event every frame, so its behaviour is unchanged. The buffer is timed by dt accumulated
in `_input` rather than `performance.now()`: when a capture script drives `update()` frame by frame,
the wall clock is not evenly spaced. This change lives in `planet.js`, so the mouse benefits too.

**Clap for the next specimen, only while the verdict is up.** Normally the recognizer tracks one hand
(`numHands:1`, half the compute, and no second hand competing for the planet); when the verdict
appears it switches to two (`rec.setOptions({numHands:2})` - in this bundle, without `baseOptions`
that rebuilds the graph synchronously but is still handled as a promise; frames during the switch are
discarded; a `stop()/start()` swapping the recognizer mid-switch has to be detected; and `numHands` is
written unconditionally in its setOptions, so it must be passed explicitly), and clicking "Next
specimen" switches back. Spin and weapons are suspended in two-hand mode. A clap is **a motion, not a
pose**: both hands open, fingertips up, and the palm distance (normalized by hand length - wrist to
middle knuckle - so it holds at any distance) must have been at least 2.2 hand lengths apart within
500ms and then close to within 1.1 at 4 hand lengths per second or more. Tracking often loses a hand
at the moment they meet, so "just closed fast and then one went missing" counts too. Classes are
ignored: a clap facing the camera is edge-on and Open_Palm's score collapses right then. MediaPipe's
ordering of the two hands varies between frames, so everything is computed symmetrically and the
handedness label is never read. Edge triggered, with a 1 second cooldown that survives a mode switch.

**Turning the planet is a UV offset, not a rotating mesh.** "The mesh never rotates" is the
precondition for the foil compressing along a fixed world plane, so horizontal dragging goes through
the existing `uSpinUV` path - what turns is the textures and clouds, while the terminator and the
latitude bands stay put. That is not a compromise: under real rotation the sun does not turn with the
planet and the latitude bands do not move either, so this path is actually more correct. Vertical
dragging raises and lowers the camera (`userEl`), which is tipping the globe to look at a pole;
reaching `TILT_MAX` has to **clear the momentum with it**, or it vibrates against the boundary forever
after release. The limit can't be too high either: any higher and `up` is nearly parallel to the view
axis, where `lookAt` degenerates.

The flick speed needs a cap. A globe's feel comes from inertia, but with no ceiling one fast sweep
turns it into a gyroscope, the surface becomes unreadable, and there is no "handling" left to speak of
- being able to see what you are turning is the point of the whole thing. Grabbing is refused during a
strike: the camera belongs to the choreography then.

The one thing the civilization can notice. Temperature and pressure they can still blame on stellar
activity, but a sky moving at the wrong speed has no explanation - `spun` accumulates the externally
imposed rotation in radians, and crossing a threshold triggers a broadcast. This is the only place in
the whole simulation where they realize they are being interfered with, and it is what this whole
interaction is really for.

**The "floating" look is a problem of kinematics and composition, not shading.** Three root causes:

`lookAt(0, 0, 0)` pins the planet permanently to the center of the frame. No real camera position
does that, so it reads as a sprite stuck to the screen. The view axis now carries a slowly drifting
offset, and the subject breathes within the frame.

The camera's `up` used to be exactly world +Y, and the planet's rotation axis is world Y too - so the
latitude bands, the direction of rotation and the poles all aligned with the screen axes, which reads
as "a sphere with a scrolling texture". Giving `up` a `CAM_TILT` is giving this planet an axial tilt
relative to the observer. **Don't rotate the mesh for it**: "the mesh never rotates" is the
precondition for the foil compressing along a fixed world plane. A side benefit is that the flattened
sheet becomes a tilted plane in space rather than a line across the screen.

The drift used to be two pure sines reversing about every forty seconds - precisely the kinematic
signature of "floating in water": no direction, no end, perfectly smooth. A noise field instead: it is
aperiodic, holds a direction for a long time, and reads as being carried along.

The same goes for the starfield. Uniformly random monochrome points read as a flat backdrop, which
turns the planet into a decal in front of it. Stars are colored by spectral type (orange-red -> white
-> blue-white, with the middle most common) and a fifth of the density is pushed into a tilted
galactic band - whose plane normal has to be offset from both the view axis and the rotation axis, or
there would be yet another screen-aligned line.

**Shake rotates, it doesn't translate.** The displacement is `trauma^2` (perception is exponential,
and squaring makes it start hard and finish cleanly), and the direction comes from one-dimensional
value noise rather than a per-frame random number - random numbers shake as high-frequency speckle,
a noise field shakes as movement. The shake is applied after `_applyCam()`, and since `_applyCam()`
resets the orientation every frame, nothing accumulates.

**The planet mesh never rotates.** Spin is implemented as an offset of the noise sampling in the
shader (`uSpin`). That keeps object-space axes fixed relative to the scene, so the foil compressing
along a fixed plane doesn't turn with it. Think this through before changing how spin works.

**The foil collapses along Y onto the horizontal plane, not along the view direction.** Flattening
cannot be seen head on - reading a thickness going to zero needs parallax. Collapsing onto the
horizontal plane with the camera at a grazing angle is what makes the sheet visible. The camera is in
position within the first 24% of the sweep, ahead of the foil reaching the planet.

**The amount of flattening is computed per vertex** (`flatAmount()` from the vertex's x relative to
the foil's position), so mid-sweep there is a frame with "the left half already a two-dimensional
painting, the right half still a sphere" - the best frame in the whole effect.

**The light source is at +X.** The foil sweeps from -X to +X, so the remaining three-dimensional
hemisphere has to be on the lit side, or what is left at the end is a black silhouette.

**`IcosahedronGeometry`'s detail subdivides each face into `(detail+1)^2`, not `4^detail`.**
The current detail 28 = 20 x 29^2 = 16820 faces, with fragments projecting to about 9px.

**Clouds and atmosphere only flatten, they never shatter.** They call `flatten()` rather than
`deform()` and disperse as a whole during the crush. An early version put them through the fragment
path, and the entire cloud shell tumbled as one rigid body.

**A fragment's afterglow hangs off its separation, `burst`, not the overall `uShatter`.** Get that
wrong and an intact sphere that hasn't broken yet glows all over, which with bloom is a solid white
disc. The core glow is the same: it has to wait until the fragments start separating.

**A fragment's tumble axis `aAxis` and scatter direction `aDir` must be independent.** Sharing one
makes each fragment spin about its own flight axis, staying face-on to the camera, and it looks like a
floor covered in confetti. Scatter speed uses `rnd^3` to lengthen the tail, so a few fly far and most
stay near.

## Survival mode

**Camera only.** The cost of a shot is putting the crosshair on the rock with your hand, which is free
with a mouse and real with a hand - the difficulty comes from the hand, not from the asteroids. So
there is no mouse version, and it isn't unfinished; below 900px `.cam` is hidden and this mode ceases
to exist with it. The entrance is in the camera panel, and turning the camera off leaves it.

**Point and it fires; there is no trigger.** No gesture is "fire": the same principle (a moving hand
never commands) means any trigger pose would have to come to rest before being classified, and the
transition frames of point-to-pinch read as None or Closed_Fist - the latter being a weapon. So a shot
takes no confirmation at all: put the crosshair on a rock and it fires (with 0.12s between shots, so
sweeping across a cluster can't clear it in one frame). A shield does need a hold - it is something
that takes up space and should not be dropped by a hand sweeping past: hold the ✌️ and one lands at
the crosshair every 0.5s, each blocking two rocks and living only 7 seconds (fading over the last
one) - a shield is a temporary thing, not a wall, and has to be replenished.
Progress only grows on frames confirmed as a V, and the hysteresis band emits `aim(null)`; but the gap
tolerance is widened to 250ms (a flickering score, one stalled camera frame), which pauses rather than
clears, and only a longer gap unwinds it. Besides absolute length, the V has a relative test: index
and middle clearly longer than ring and pinky - a half-curled ring finger or a V tilted toward the
camera collapses the absolute lengths while leaving the ratio untouched. At 8 shields alive, a new one
evicts the oldest.

**Hold the finger upright and move your hand; don't aim it like a laser pointer.** The crosshair
follows the fingertip's *position* in the camera frame, not the direction the finger points - angling
the finger at a rock does nothing, moving your hand is what moves the crosshair. So the pose that
works is an index finger straight up with the palm toward the camera, the hand moving around the
frame. It is also the pose both recognition paths are built for (below), and the gain is 1.25, so the
hand only has to cover the middle 80% of the camera frame to reach every edge of the screen - reaching
with the whole arm makes tracking worse, not better.

**Pointing needs a geometric test.** `Pointing_Up` only recognizes a vertical index finger and its
score collapses when pointing at a corner of the screen. A soft score from fingertip-to-wrist distance
(normalized by hand length) - index extended, the other three curled - is maxed with the classifier's
score and runs through the same hysteresis. The fingertip gets its own pair of One-Euro filters rather
than sharing the palm's: the palm judges speed, the fingertip is the crosshair. Fingertip-to-viewport
gain is 1.25, with y corrected by (viewport aspect / camera aspect) so a circle drawn by the hand is
still a circle on screen (derivation: a displacement d is d/W and d/H in the camera frame, and equal
distances on screen require gy = gx * viewport aspect / camera aspect).
Both scores fall together when the finger is tilted toward the camera: the classifier wants a vertical
finger, and foreshortening shortens the measured tip-to-wrist distance against `EXT_UP`, so the
geometric fallback that exists to cover the classifier drops out at the same moment. That is why an
upright, in-plane finger tracks best, and why the player-facing rule above is worth stating.

**Weapons stay live.** The classifier knows nothing about "modes", and disabling the fist would mean
inventing another set of transition rules; besides, this is exactly where the tension comes from - a
clenched fist crushes the thing you are protecting. There is one conflict rule: **a still, confident
weapon beats aiming, and never the other way round**; a moving hand has its weapon scores zeroed, so
aiming can never be stolen. Switching from aiming to a fist skips the 120ms exit delay and
reclassifies on the same frame - a still fist is unambiguous.

**A shield costs pressure.** One plate shatters after blocking two impacts (and only lives 7 seconds
anyway), but it is something added to the atmosphere: pressure runs on a log axis, so two plates put
habitability at 0.61 and seven at 0.10, and after a few the civilization's own `thick1` (7.5 atm)
broadcast arrives - their readouts are your scoreboard. This is the only resource decision in the
mode. A shield is opaque (55% body, glowing edge) and **registers depth rather than hiding**: hidden,
its pixels would take the starfield's depth and depth of field would smear its 0.42-unit hard edge
across 8 pixels, and then it would no longer be "a two-dimensional thing".

**Impacts have to stick to the ground.** `n0` does not follow the texture (spin is a UV offset), so
storing a world direction directly would let the flash slide off the ground (0.055 rad/s, 12 degrees
in four seconds). The direction is de-spun by `uSpinUV` at the moment of impact before being stored,
and the shader rotates it back by the current `uSpinUV`; the sign follows from SphereGeometry's UV
convention (see `IMPACT_N` in `planet.js`), and the way to test it is to hit a recognizable coastline
and then spin the planet. A crater's angular radius is about the rock's radius, and the glow factor is
0.9: for the half second after landing it just crosses the bloom threshold and flashes, then falls
back to a dark red afterglow that doesn't clip - at 3.2 every crater is a solid white blob smearing
half the planet. Scars remain only on land and dried-out sea floor, and dust covers them over a minute.

**Foreign objects must register depth.** The depth map for depth of field renders the whole scene as
usual, and an unregistered mesh writes its own color into it. Opaque ones (the asteroid InstancedMesh,
the shields) use `trackDepth` - one vertex shader covers translation, rotation and scale including the
instance matrix; additive ones (beams, debris) use `overlay` and are hidden while depth is rendered.
Asteroids spawn on a ring on the plane through the planet's center perpendicular to the view axis
(radius 2.8, against a half-frame width of 2.58, so just off screen), which both brings them in from
the edge and keeps them inside the +/-2.5 in-focus band.

**There are no lights.** There are no THREE lights anywhere in this scene; the asteroids and shields
compute their own Lambert term from `uLightDir` exactly as the planet does. An asteroid's albedo is
held below 0.3, and its entry glow burns on the side facing the planet (which is the leading face, so
no velocity needs passing in) and crosses the bloom threshold. A beam's blue channel goes over 1.1
while red is held under 1: blue light, not white, for the same reason as the foil.

**Score comes only from asteroids, and self-ending is its own rule.** (Summary: 5 a kill, 2 a block,
+20 for ending it yourself, nothing for time.) 5 for a kill, 2 for one a shield
blocks, and nothing for time: surviving isn't the skill, shooting them down is, and giving blocks
points is what makes the shields' pressure cost worth paying. Difficulty steps by score: slow to
start, a little faster at 125 points (twenty-five rocks), faster again at 200 (forty), then another
ten percent per 100; time multiplies on top with another step at thirty seconds and at sixty (x1.15 /
x1.30), so someone who only blocks can't outrun the clock either - targets are approached with tau=4s
so a step reads as "a bit faster" rather than a jump.
Reaching 640K (melting has just begun and `hot3` has aired) runs the existing gravity crush - the
score still stands, and the tier follows it: 100 points DEMIGOD, 250 GOD, otherwise HUMAN. Firing a
weapon yourself (fist / open palm) to end the run adds **+20** (four rocks' worth), but **the tier is
always DEVIL** - even at a god's score, the moment you act you are the devil. From 560K a warning
hangs in the center of the screen (red from 610K). In survival the verdict is about you - tier, score,
how it ended - rather than their story. Which makes "when to stop" the real decision in this mode: the
longer you hold on the higher the score, and the likelier the next rock gets through.
The civilization falling silent (they are gone around 391K) is something that happens along the way,
not an ending - the ending is the planet.

**A kill is a handful of grit, not a disappearance.** A rock that is hit breaks into 7-11 shards using
the same instanced renderer (glowing red, tumbling fast, flying apart, shrinking, cooled within half a
second), colliding with nothing and untargetable. Plus a white flash and the beam. The hit circle is
also generous at `max(46, projected radius * 2.6 + 22)` pixels - a hand shakes more than a mouse.

## Survival scoring (optional)

At the end of a run, the observer themselves is drawn: **DEVIL** (you crushed it yourself, at any
score), **HUMAN** (the planet died before you did, under 100 points), **DEMIGOD** (>=100, twenty
rocks) and **GOD** (>=250, fifty rocks). Within a tier, a higher score means a fiercer image: three
levels per tier (`POWER` in `serve.py`), written into the prompt as its "Power level" paragraph -
lesser devil / devil / archdevil, rookie / veteran / legend, and so on. The portrait is generated by
Gemini from the expression at that moment: a 16:9 landscape in HD (1K is about 1344x768, and
`GEMINI_IMAGE_SIZE=2K` is sharper), always bright, the face sharp and flattered, with a background
that is a whole world per tier (god: sunlit clouds and wings of light; devil: lava and embers; human:
a bright observation room). Each tier is a complete character brief: the human is a defender with twin
pistols, the devil holds an obsidian spear veined with lava, the demigod is a half-ascended warrior in
the dawn light on a summit (a partial halo, a single wing, a sword of light and a planet above the
palm), and the god has rings and wings of light behind them and planets in their hands. The
composition is a medium shot from the waist up, with the hands and props in frame. The tier is written
on the scorecard and on the board (DEVIL / HUMAN / DEMIGOD / GOD).
The model occasionally hands back a murky image, so the server measures the mean brightness once and
lifts the dark ones a stop (only with Pillow present, same as `fetch-assets.sh`).
Everything stays on your machine, board included. This part needs a local server, which is what
`serve.py` is; on GitHub Pages there is none, so the verdict still appears, the portrait degrades to
the raw snapshot tinted by tier, and the board lives only in the page's memory.

```bash
cp .env.example .env      # fill in GEMINI_API_KEY (or just export it)
python serve.py 8123      # startup prints whether the key loaded; the first run lists the available models and picks by preference
```

The flow: on **the frame** a run ends (you fire a weapon, or the rock that pushes it through 640K
lands) a mirrored JPEG is grabbed from the camera - the verdict waits out a 2.7 second shatter
animation, and by then the reaction has left the face. `POST /api/finish` -> the text model reads the
emotion (strict JSON out, lenient parsing in) -> the image model generates the portrait for that tier
(keeping the person's face and their expression, never a caricature) -> saved to
`runs/<time>_<callsign>_<tier>.png|jpg` -> appended to `runs/leaderboard.json` (atomically replaced).
A failed portrait is not a failed request: the board still records it and the portrait is left empty.
A callsign has to be entered before a run and is remembered in `localStorage`.

Privacy: the snapshot happens once, at the end of a run, goes only to Google's Gemini API, and the raw
frame is never written to disk; the portrait and the board live only in the local `runs/`. The key is
read only from the environment or from a `.env` in the same directory, and `serve.py` serves no
dotfiles at all. `deploy.sh` needs no changes: it only copies `index.html css js ...`, so `runs/` and
`.env` are naturally not in the list.

## Rendering pipeline

The scene renders in **linear HDR**, with emissive terms (city lights / magma / ocean highlights /
foil / core) deliberately outputting values above 1.0. The chain is
`RenderPass -> depth of field -> UnrealBloom -> OutputPass (ACES + sRGB) -> grain`.

**Depth of field has to render its own depth map.** three's own `BokehPass` renders depth with
`scene.overrideMaterial`, which bypasses the deformation written into our vertex shader - a fragment's
depth would stay on the unshattered sphere, and the near fragments that most need blurring would come
out perfectly sharp. So it renders one by swapping materials per object, with the deformation sharing
the same uniforms; what is stored is radial distance to the camera (divided by `DEPTH_FAR = 20`), and
the starfield at 42-56 clamps to 1.0 and naturally falls out of focus. The focal plane is locked to
the planet's center so the focus pulls back with the camera - otherwise everything blurs the moment
the crush starts moving it. Sampling uses a Vogel spiral (points spread by the golden angle, close to
a Poisson disc, and needing no const array, which GLSL ES 1.0 doesn't support), with an early exit in
the in-focus region that saves sampling the whole screen.

**Grain hangs off the end, after `OutputPass`**: it is a product of film or a sensor and belongs in
display space after tone mapping; in front of it, it would be tone mapped along with everything else.
Its strength is weighted by luminance, heaviest in the midtones and nearly absent at pure black and
pure white - adding noise uniformly just looks dirty.

**The DPR is capped at 1.5 and then adapted from frame time.** The planet shader runs twice per frame
(color plus the self-rendered depth map) on top of 16-sample depth of field and five bloom levels: a
full Retina resolution is 3024x1424, and four megapixels pin even an M-series chip at 30fps (a frame
time sitting exactly on 33.3ms, which is half the vsync rate). Capping at 1.5 removes 44% of the
fragments; the main loop then watches the mean real frame interval and steps down (1.5 -> 1.25 -> 1.0)
after a second or so above 22ms, stepping back up after six seconds below 13ms. The post chain is all
soft, so it looks nearly identical.

**The bloom threshold of 1.10 is above the peak of every diffuse surface** (ice about 1.03, clouds
0.90), so only emissive terms clip into it: magma 3.2 / city lights 2.3 / sea reflection 1.9 / the
foil / the core. That is far cleaner than lowering each material's brightness one by one - an early
version put the threshold at 0.78 and then had to keep back-solving coefficients for the clouds and
ice, which once darkened were dimmer than the sea.

**The terminator transition has to be narrow.** `smoothstep(-0.06, 0.14, ndl)`. Too wide (0.48 across,
early on) stretches the light-dark boundary into a broad gradient over high-albedo surfaces, and the
planet's edge reads as blurred rather than as a silhouette.

**The mesh never rotates; spin is a horizontal UV offset** (textures are `RepeatWrapping` so they wrap
automatically, with continuous derivatives and no seam; don't use `fract()`, which moves the
discontinuity into the middle of the frame). That is what lets the foil compress along a fixed world
plane without turning with it, and it lets lighting face the sun with world-space normals directly,
skipping a whole coordinate conversion.

**The atmosphere is analytic single scattering, not a rim-lit spherical shell.** For each view ray it
finds the chord it actually travels through the atmosphere and integrates along it, with density
falling off exponentially with height, so it reaches zero at the outer edge naturally. The previous
approach was a shell plus fresnel, and that shell's geometric outer boundary became a visible
"membrane" - which came from the shape, and no amount of parameter tuning could rescue it.

Derive the scattering coefficients dimensionally rather than tuning by feel: a grazing path is about
1.09 long at a mean density of about 0.5, and putting the blue end's optical depth near 1.5 (the
exponent already carries a factor of 2.30) means the coefficient toward the sun should be of order
1.2. Setting it to 7.5 scatters all the blue out of the day side and leaves a blown-out white rim.
The red of a sunset is computed, not dialled in - blue scatters most strongly and is removed first
when passing through thick atmosphere.

The atmosphere's thickness Ra=1.14 is exaggerated (Earth's is about 1.016, essentially invisible at
this scale). At 1.55 the atmosphere fills the entire field of view. A thin-shell integral has to be
jittered per pixel; evenly spaced samples leave concentric banding.

**Every temperature effect is a mask over the texture**, in the four sections laid out in order inside
`PLANET_FRAG`. What gives temperature away is never the palette, it is **the whole planet changing
along one curve** - a real phase change has a front, an order and a raggedness, and each of the four
sections restores that:

**Ice caps** are not a line of latitude. Noise breaks the margin up; the sea freezes first (thin ice
spreads fast, while a land ice sheet has to be built up snowfall by snowfall, so `iceLine` pushes
water down by an extra 0.13); and dry, bright highlands and deserts radiate heat away fastest and go
white early. The edge of sea ice also **breaks into floes**: `(1-|2i-1|)` peaks in the transition band
and vanishes at both ends, so the high-frequency noise only stirs the boundary ring while the interior
of the cap and the open water are untouched; land is excluded, since a snow line is naturally tidier
than a sea-ice edge.

**Desertification** is weighted by latitude. The subtropics are the descending branch of the Hadley
cell and dry out first; equatorial rainforest has the most moisture and collapses last. Multiplying by
a patch noise makes the drought front something gnawed out rather than pushed flat.

**Oceans boiling dry** follow two curves, shallow and deep: `boilShallow` 362->438 and `boilDeep`
424->516, interpolated by proximity to shore (decided by sampling the water mask at four points).
**Both have to reach 1** - it used to be one curve discounted by depth, and the deep basins then only
ever dried out about forty percent however hot it got, leaving a patch of blue at maximum temperature,
which was the falsest thing of all. The boiling phase also pushes cloud cover up first (`steam` in
`setEnv`): seawater has to become vapour before it can disperse.

**Melting** lowers the fissure exponent as it progresses (`mix(11.0, 3.4, melt)`): thin cracks -> wide
cracks -> continuous. With a fixed exponent the magma is the same width from start to finish and
merely gets brighter, which is not melting, it is turning up the brightness. White heat is reserved
for the stretch near total melt; given out earlier, the planet smears into a star at eight hundred
degrees.

## Tuning

The top of `js/civ.js` holds the civilization model's constants (ideal temperature 288K, ideal
pressure 1atm, baseline population). The comms log copy is in `_check()`, laid out by trigger
condition.

`setEnv()` in `js/planet.js` maps temperature and pressure to cloud cover, atmospheric density and
color; `PLANET_FRAG` holds the surface palette and the various thresholds (ice line, aridity, boiling,
melting).

## Backups

The whole of the mutable state is `runs/`: `leaderboard.json`, the portraits and `quota.json`. On a
droplet it is a Docker volume:

```bash
docker run --rm -v dimension-strike_runs:/r -v "$PWD":/b alpine \
  tar czf /b/runs-backup.tgz -C /r .
```

Restoring is the same command with `tar xzf`. There is no database and nothing else to back up.

**On App Platform there is nothing to mount and no disk to copy**, so a deploy is a data loss event
and the only backup is one taken over HTTP beforehand:

```bash
curl -s https://<app>.ondigitalocean.app/api/leaderboard?limit=50 > board-backup.json
```

Be clear about what that does and does not save. It captures callsigns, scores and tiers - the ranking
- and the board popup's CSV export is the same data by hand. It does **not** capture the portraits:
`/api/portrait/:id` serves an image only to the browser that generated it, so there is no route that
can collect everyone's, which is the privacy property working as intended rather than a gap. Nor is
there an import endpoint, so a restore means re-entering runs, not uploading a file. Treat the JSON as
a record, not as something you can put back.

## Credits

Built on [Mr-Salticidae/dimension-strike](https://github.com/Mr-Salticidae/dimension-strike): the
planet renderer, the shaders, the gesture pipeline and the art direction are theirs. Survival mode, the
scoring service and the deployment are added on top.

Surface imagery from [Solar System Scope](https://www.solarsystemscope.com/textures/), CC BY 4.0.
Gesture recognition by [MediaPipe](https://developers.google.com/mediapipe).

## Security summary

- The deployment's key lives only in the server environment and reaches Google in a request header. It
  is never sent to a browser, and `/api/health` returns a boolean rather than the value.
- A visitor's own key is used for their request and nothing else: not logged, not stored, not returned.
- Public rows carry warning codes, never exception text, because error strings are how secrets escape.
- Clearing the board needs `DS_ADMIN_TOKEN`; without one configured, only loopback may clear.
- Portraits are served solely by `/api/portrait/:id`, which checks ownership. `runs/` is not static.

## Known limits

- Free-credit tracking is deterrence, not enforcement: a fresh browser or a VPN earns another one.
- Callsign uniqueness is per board, so clearing it frees every name.
- The demo video in `docs/` shows a pre-translation interface.
- Runs recorded before ownership tracking have no owner and show the placeholder to everybody.
- On App Platform the free-credit ledger is erased by every deploy, so `DS_FREE_PORTRAITS` means
  "ever" only until the next one. `DS_GLOBAL_PER_DAY` is the only limit a redeploy cannot reset.
- `canClear` in `/api/health` is not an authorization answer. With `DS_ADMIN_TOKEN` configured it is
  `false` for everyone; the stored token reveals the control and the server re-checks the header.
- An App Platform app's hostname is fixed at creation. Renaming changes the dashboard label only, so
  the URL can disagree with the name indefinitely - as it does here.
- The board can be exported but not imported, so a backup is a record rather than a restore.
