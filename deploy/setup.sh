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
[ -n "${DOMAIN:-}" ] && [ "$DOMAIN" != "play.example.com" ] || {
  echo "set DOMAIN in deploy/.env to the name whose A record points at this droplet" >&2; exit 1; }

echo "==> Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

echo "==> firewall (SSH + HTTP + HTTPS only)"
if command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
fi

echo "==> checking that $DOMAIN points here (Caddy cannot get a certificate otherwise)"
want=$(curl -fsS --max-time 10 https://api.ipify.org || echo '')
got=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || echo '')
if [ -n "$want" ] && [ -n "$got" ] && [ "$want" != "$got" ]; then
  echo "    warning: $DOMAIN resolves to $got but this droplet is $want" >&2
  echo "    fix the A record first, or Caddy will fail the ACME challenge and retry" >&2
fi

echo "==> build and start"
docker compose up -d --build

echo
echo "Done. Caddy issues the certificate on the first request, which can take a few seconds."
echo "  site:   https://$DOMAIN"
echo "  logs:   docker compose logs -f"
echo "  unlock: https://$DOMAIN/?admin=\$DS_ADMIN_TOKEN   (once, to reveal the board's CLEAR control)"
