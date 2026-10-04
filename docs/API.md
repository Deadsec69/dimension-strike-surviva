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
