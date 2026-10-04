# Security

## Reporting

Open an issue on the repository. There is no bounty and no SLA; this is a personal project.

## What is protected

- **Keys.** The deployment's key exists only in the server environment and is sent to Google in a
  request header. It never reaches a browser. A visitor's own key is used for that one request and is
  never logged, stored, or echoed back.
- **Portraits.** They are likenesses of real faces. Only the browser that generated one can fetch it;
  `runs/` is not served as static files, and `/api/portrait/:id` checks ownership before reading.
- **Destructive actions.** Clearing the board needs an admin token, compared in constant time. Without
  a token configured, only loopback may clear.
- **Error strings.** Public rows carry short codes. Exception text goes to the server log, where the
  operator can see it and a visitor cannot.
- **Secrets in the repository.** `.do/app.yaml` is committed and declares `GEMINI_API_KEY` and
  `DS_ADMIN_TOKEN` as `SECRET` with no value, so the spec is safe to publish. The real values live in
  the gitignored `.env`, and `deploy/do-apply.sh` merges them into the spec in memory and pipes it to
  `doctl` on stdin - the merged spec is never written to disk, so there is no temp file to leak or to
  forget to delete. On the platform side they are stored encrypted and read back only as `EV[1:...]`
  ciphertext; nothing retrieves a plaintext secret from a deployed app.

## Fixed issues worth remembering

- **Percent-encoding walked past the path guards** (fixed). `do_GET` screened the *raw* request path
  for dotted segments and a `runs/` prefix, but `SimpleHTTPRequestHandler.translate_path` unquotes
  before opening the file, so `/%2Eenv` returned `.env` (key included) and `/%72uns/<run>.jpg` returned
  a player's portrait - both measured at 200 against a local server. The deployed site was shielded
  only because App Platform's proxy normalises URLs before the container sees them, which is not a
  property this code should depend on. The guards now run on `urllib.parse.unquote(path)`.

  The lesson generalises: a check and the operation it protects must agree on the string they are
  looking at. If a guard reads the request and the filesystem reads something derived from it, the
  guard is advisory.

## What is not protected

- Free-credit limits are deterrence. A fresh browser, incognito or a VPN earns another generation;
  real enforcement needs accounts.
- Anyone who can open the site can consume the configured daily portrait allowance.
- The board is public by design. Callsigns and scores are visible to everyone.
