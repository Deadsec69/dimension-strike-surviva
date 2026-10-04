# HTTP API

Everything lives under `/api/`. Responses are JSON unless stated otherwise. There is no versioning:
the client and server ship together.

Identity is an HttpOnly `ds_uid` cookie, set on the first request. It decides whose portraits you may
see and how much free credit you have left. It is never returned in a response body.

## GET /api/health

The probe the page makes on load. Cheap and non-blocking.

```json
{ "ok": true, "hasKey": true, "models": { "image": "...", "text": "..." },
  "discovered": false, "runs": 7, "freeLeft": 1, "freeTotal": 1, "canClear": false }
```

`hasKey` is a boolean - the key itself is never sent. `models` may be the preference list before the
background discovery finishes; `discovered` says whether it has.

## GET /api/leaderboard?limit=N

One row per callsign - a player's best run - sorted by score. `limit` is clamped to 1..50.

Each row carries `portrait`, which is `api/portrait/<id>` for runs this browser generated and the
shared placeholder for everyone else, plus `mine: true|false`. See `public_row()` in `serve.py`.

## GET /api/run/:id

One run, same shape as a leaderboard row. Used while polling for a portrait that is still generating:
`pending: true` means keep asking.

404 if the id is unknown.

## GET /api/portrait/:id

The generated image, as `image/jpeg` or `image/png`.

**Only for the browser that generated it.** The request's `ds_uid` must match the run's owner, or the
answer is 404 - the same answer an unknown id gets, so the endpoint does not confirm which runs exist.
`runs/` is not served as static files, so this is the only route to a portrait.

## POST /api/finish

Records a finished run and, if a key and credit are available, starts a portrait in the background.

```json
{ "username": "...", "score": 194, "kills": 34, "blocks": 12, "elapsed": 136.7,
  "ending": "self|heat", "tier": "devil|human|demigod|god",
  "snapshot": "<base64 jpeg>", "apiKey": "<the visitor's own, optional>" }
```

Returns the stored row, the top of the board and a `warnings` array. **A failed portrait is not a
failed request**: the run is always recorded, and only the image degrades.

## POST /api/leaderboard/clear

Deletes every run and every portrait file. Irreversible.

Requires `X-Admin-Token` matching `DS_ADMIN_TOKEN`. With no token configured the server assumes it is
local and accepts the call from loopback only. Anything else gets 403.

## Warning codes

`warnings` carries short codes, never exception text - the field is public, and raw errors are where
secrets escape. The detail goes to the server log instead.

| Code | Meaning |
|---|---|
| `no_snapshot` | No camera frame was sent |
| `no_key` | No key configured and none supplied |
| `free_used` | This visitor's free credit is spent |
| `daily_cap` | The global daily ceiling was reached |
| `rate_limited` | Too many runs from this IP this hour |
| `emotion_failed` | The expression read failed |
| `portrait_failed` | Generation failed after a retry |
