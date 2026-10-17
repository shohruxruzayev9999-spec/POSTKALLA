#!/usr/bin/env bash
# Runs ON the server. Touches only: ~/postkalla, /var/www/postkalla, the nginx site "postkalla"
# and its certificate. The old ERP (retarget-erp) and its nginx site are never modified.
set -euo pipefail
DOMAIN="$1"
PLATFORM_ADMINS="${2:-}"
APP=~/postkalla
mkdir -p "$APP/backups"
cd "$APP"

# 1. Secrets: generated once on the server, never leave it. Bot token comes from GitHub Secrets.
if [ ! -f .env ]; then
  umask 077
  printf 'DB_PASSWORD=%s\nJWT_SECRET=%s\n' "$(openssl rand -hex 16)" "$(openssl rand -hex 32)" > .env
fi
BOT_TOKEN="$(cat .bot_token)"; rm -f .bot_token
AI_KEY=""; if [ -s .ai_key ]; then AI_KEY="$(cat .ai_key)"; fi; rm -f .ai_key
grep -v -E '^(BOT_TOKEN|DOMAIN|ANTHROPIC_API_KEY|PLATFORM_ADMIN_TG_IDS)=' .env > .env.tmp || true
printf 'BOT_TOKEN=%s\nDOMAIN=%s\nANTHROPIC_API_KEY=%s\nPLATFORM_ADMIN_TG_IDS=%s\n' "$BOT_TOKEN" "$DOMAIN" "$AI_KEY" "$PLATFORM_ADMINS" >> .env.tmp
mv .env.tmp .env && chmod 600 .env

# 2. Memory: the VM is small and shared with the old ERP — make sure some swap exists.
if [ "$(swapon --show --noheadings | wc -l)" = "0" ] && [ ! -f /swapfile ] && [ "$(df --output=avail -k / | tail -1)" -gt 3000000 ]; then
  sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# 3. Backup before anything changes (migrations run on start); abort if it fails.
COMPOSE="sudo docker compose -f compose.shared.yml --env-file .env"
if $COMPOSE ps --status running db | grep -q db; then
  $COMPOSE run --rm --no-deps --entrypoint sh backup /backup.sh once || { echo "pre-deploy backup failed — deploy aborted"; exit 1; }
fi

# 4. Containers. The running image is kept as :previous; if the new one is not healthy the
#    previous image comes back automatically.
sudo docker image inspect postkalla-api:latest >/dev/null 2>&1 && sudo docker tag postkalla-api:latest postkalla-api:previous
gunzip -c /tmp/postkalla-api.tar.gz | sudo docker load
$COMPOSE up -d --remove-orphans
healthy() {
  for i in $(seq 1 40); do
    if curl -fsS http://127.0.0.1:8090/api/health >/dev/null; then return 0; fi
    sleep 3
  done
  return 1
}
if ! healthy; then
  echo "new API is not healthy — rolling back to the previous image"
  $COMPOSE logs --tail 80 api
  if sudo docker image inspect postkalla-api:previous >/dev/null 2>&1; then
    sudo docker tag postkalla-api:previous postkalla-api:latest
    $COMPOSE up -d --force-recreate api
    healthy && echo "rolled back; the pre-deploy backup is in ~/postkalla/backups"
  fi
  exit 1
fi
sudo docker image prune -f >/dev/null

# 5. Web build (the previous one stays in /var/www/postkalla.old)
sudo mkdir -p /var/www/postkalla
sudo rm -rf /var/www/postkalla.new && sudo mkdir -p /var/www/postkalla.new
sudo tar xzf /tmp/postkalla-web.tar.gz -C /var/www/postkalla.new
sudo rm -rf /var/www/postkalla.old; sudo mv /var/www/postkalla /var/www/postkalla.old; sudo mv /var/www/postkalla.new /var/www/postkalla

# 6. nginx site (only on first deploy), always validated before reload
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

# 7. HTTPS certificate for the new name only
if ! sudo test -d "/etc/letsencrypt/live/$DOMAIN"; then
  sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
fi
sudo nginx -t && sudo systemctl reload nginx

# 8. Health
for i in $(seq 1 30); do
  if curl -fsS "https://$DOMAIN/api/health"; then echo; echo "OK https://$DOMAIN"; exit 0; fi
  sleep 3
done
sudo docker compose -f compose.shared.yml logs --tail 80 api
exit 1
