# Configuration

Every setting is an environment variable. `serve.py` also reads a `.env` next to it at startup; real
environment variables win over anything in that file.

Nothing here has a default that costs money. With no key set at all the game plays, the board records
every run, and portraits simply stay empty.

## `GEMINI_API_KEY`

Your Gemini key. Used for a visitor's free portrait, and for every portrait if they bring no key of
their own. Read from the environment or `.env`; it is never sent to a browser and never written to
`runs/`.

Unset is a supported mode, not an error: runs still score and the board still records them.

## `GEMINI_IMAGE_MODEL / GEMINI_TEXT_MODEL`

Pin the models instead of discovering them. Leave both blank and the server starts with its preferred
pair and calibrates against `/v1beta/models` in a background thread - the listing endpoint has been
measured at 122s, which a finishing run cannot wait for.

## `GEMINI_IMAGE_SIZE`

`1K` (default) is about 1344x768 at 16:9. `2K` is sharper and roughly twice as slow. The portrait is a
landscape banner either way; the aspect ratio is not configurable because the UI reserves a 16:9 slot
for it.

## `DS_ADMIN_TOKEN`

Required to clear the leaderboard. Generate one with `openssl rand -hex 24`.

Unset means the server assumes it is local and accepts a clear from loopback only. That keeps local
development exactly as it was while making a public deployment safe by default.

Sent as the `X-Admin-Token` header and compared with `secrets.compare_digest`, so a wrong token leaks
nothing through timing. To unlock the control in a browser, visit `/?admin=<token>` once - it is stored
in `localStorage` under `ds.admin` and the query string is stripped from the address bar immediately,
so the token does not sit in history or in a shared screenshot.

Note that `canClear` in `/api/health` is not the answer to "may I clear". It reports
`(not ADMIN_TOKEN) and client_ip in (127.0.0.1, ::1)`, so with a token configured it is `false` for
everybody - the stored token is what reveals the button, and the server re-checks the header on the
request itself.

## `DS_FREE_PORTRAITS`

How many portraits a visitor gets on your key, ever. Default `1`.

Counted against their `ds_uid` cookie. Clearing cookies earns another one, which is what
`DS_FP_PER_DAY` exists to blunt.

## `DS_FP_PER_DAY`

Free portraits per IP + user-agent bucket per day. Default `3`.

The backstop behind the cookie. The bucket is a truncated hash; the raw IP is never stored. Set it
higher if several people share one connection, which is normal on office or campus networks.

## `DS_GLOBAL_PER_DAY`

A ceiling on your key across all visitors per day. Default `60`. The thing that stops a link going
around and emptying your quota overnight.

## `DS_RUNS_PER_HOUR`

Finished runs accepted per IP per hour, whether or not a key is involved. Default `30`. This one
protects the server rather than the quota.

## `PORT / HOST`

`PORT` set makes the server bind `0.0.0.0` - what a container platform needs. Unset, it binds
loopback on 8123 (or `argv[1]`), so running it locally never exposes anything to the network by
accident. `HOST` overrides the address explicitly.
