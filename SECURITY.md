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
