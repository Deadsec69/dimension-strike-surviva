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
