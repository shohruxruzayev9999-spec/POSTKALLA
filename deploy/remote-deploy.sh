#!/usr/bin/env bash
# Runs ON the server. Touches only: ~/postkalla, /var/www/postkalla, the nginx site "postkalla"
# and its certificate. The old ERP (retarget-erp) and its nginx site are never modified.
set -euo pipefail
DOMAIN="$1"
APP=~/postkalla
mkdir -p "$APP/backups"
cd "$APP"

# 1. Secrets: generated once on the server, never leave it. Bot token comes from GitHub Secrets.
if [ ! -f .env ]; then
  umask 077
  printf 'DB_PASSWORD=%s\nJWT_SECRET=%s\n' "$(openssl rand -hex 16)" "$(openssl rand -hex 32)" > .env
fi
BOT_TOKEN="$(cat .bot_token)"; rm -f .bot_token
grep -v -E '^(BOT_TOKEN|DOMAIN)=' .env > .env.tmp || true
printf 'BOT_TOKEN=%s\nDOMAIN=%s\n' "$BOT_TOKEN" "$DOMAIN" >> .env.tmp
mv .env.tmp .env && chmod 600 .env

# 2. Containers
gunzip -c /tmp/postkalla-api.tar.gz | sudo docker load
sudo docker compose -f compose.shared.yml --env-file .env up -d --remove-orphans
sudo docker image prune -f >/dev/null

# 3. Web build
sudo mkdir -p /var/www/postkalla
sudo rm -rf /var/www/postkalla.new && sudo mkdir -p /var/www/postkalla.new
sudo tar xzf /tmp/postkalla-web.tar.gz -C /var/www/postkalla.new
sudo rm -rf /var/www/postkalla.old; sudo mv /var/www/postkalla /var/www/postkalla.old; sudo mv /var/www/postkalla.new /var/www/postkalla

# 4. nginx site (only on first deploy), always validated before reload
SITE=/etc/nginx/sites-available/postkalla
if [ ! -f "$SITE" ]; then
  sudo tee "$SITE" >/dev/null <<NGINX
server {
    listen 80;
    server_name $DOMAIN;
    root /var/www/postkalla;
    index index.html;
    client_max_body_size 1m;
    location /api/ {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
    location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; }
    location / { try_files \$uri /index.html; }
}
NGINX
  sudo ln -sf "$SITE" /etc/nginx/sites-enabled/postkalla
  if ! sudo nginx -t; then
    echo "nginx config invalid — rolling back, old site untouched"
    sudo rm -f /etc/nginx/sites-enabled/postkalla "$SITE"
    exit 1
  fi
  sudo systemctl reload nginx
fi

# 5. HTTPS certificate for the new name only
if ! sudo test -d "/etc/letsencrypt/live/$DOMAIN"; then
  sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
fi
sudo nginx -t && sudo systemctl reload nginx

# 6. Health
for i in $(seq 1 30); do
  if curl -fsS "https://$DOMAIN/api/health"; then echo; echo "OK https://$DOMAIN"; exit 0; fi
  sleep 3
done
sudo docker compose -f compose.shared.yml logs --tail 80 api
exit 1
