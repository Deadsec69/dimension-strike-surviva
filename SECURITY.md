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

## What is not protected

- Free-credit limits are deterrence. A fresh browser, incognito or a VPN earns another generation;
  real enforcement needs accounts.
- Anyone who can open the site can consume the configured daily portrait allowance.
- The board is public by design. Callsigns and scores are visible to everyone.
