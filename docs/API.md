# HTTP API

Everything lives under `/api/`. Responses are JSON unless stated otherwise. There is no versioning:
the client and server ship together.

Identity is an HttpOnly `ds_uid` cookie, set on the first request. It decides whose portraits you may
see and how much free credit you have left. It is never returned in a response body.
