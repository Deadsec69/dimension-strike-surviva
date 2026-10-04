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

## `DS_FREE_PORTRAITS`

How many portraits a visitor gets on your key, ever. Default `1`.

Counted against their `ds_uid` cookie. Clearing cookies earns another one, which is what
`DS_FP_PER_DAY` exists to blunt.

## `DS_FP_PER_DAY`

Free portraits per IP + user-agent bucket per day. Default `3`.

The backstop behind the cookie. The bucket is a truncated hash; the raw IP is never stored. Set it
higher if several people share one connection, which is normal on office or campus networks.
