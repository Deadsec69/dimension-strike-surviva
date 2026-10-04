#!/usr/bin/env bash
# One-shot bootstrap for a fresh Ubuntu droplet. Run it as root on the droplet:
#
#   ssh root@<droplet-ip>
#   git clone https://github.com/Deadsec69/dimension-strike-surviva.git /opt/dimension-strike
#   cd /opt/dimension-strike/deploy && cp .env.example .env && nano .env   # set DOMAIN + GEMINI_API_KEY
#   bash setup.sh
#
# It installs Docker, opens the firewall and starts the stack. Re-running it is safe.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "deploy/.env is missing - copy .env.example and fill it in first" >&2; exit 1; }
set -a; . ./.env; set +a

# No domain? Derive one from the droplet's own IP. sslip.io resolves 134-209-1-2.sslip.io to
# 134.209.1.2, so the hostname *is* the address - nothing to register, nothing to configure - while
# still being a real name, which is what lets Caddy obtain a real certificate. Without one the browser
# blocks the camera and there is no game.
IP=$(curl -fsS --max-time 10 https://api.ipify.org || true)
if [ -z "${DOMAIN:-}" ] || [ "$DOMAIN" = "play.example.com" ]; then
  [ -n "$IP" ] || { echo "could not detect this droplet's public IP; set DOMAIN in deploy/.env" >&2; exit 1; }
  DOMAIN="$(echo "$IP" | tr '.' '-').sslip.io"
  export DOMAIN
  echo "==> no DOMAIN set, using $DOMAIN (resolves to $IP)"
fi

echo "==> Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

echo "==> firewall (SSH plus one public port: 443)"
if command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null 2>&1 || true     # without this you lock yourself out of the droplet
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
fi

echo "==> checking that $DOMAIN points here (no certificate is possible otherwise)"
got=$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || echo '')
if [ -n "$IP" ] && [ -n "$got" ] && [ "$IP" != "$got" ]; then
  echo "    warning: $DOMAIN resolves to $got but this droplet is $IP" >&2
  echo "    Caddy will fail the challenge and keep retrying until that agrees" >&2
fi

echo "==> build and start"
docker compose up -d --build

echo
echo "Done. Caddy obtains the certificate on the first request over TLS-ALPN, which takes a few seconds."
echo "  site:   https://$DOMAIN"
echo "  logs:   docker compose logs -f"
echo "  unlock: https://$DOMAIN/?admin=\$DS_ADMIN_TOKEN   (once, to reveal the board's CLEAR control)"
echo
echo "Note: only 443 is open, so http:// does not redirect - share the https:// URL above."

