#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu/Debian VM (GCP e2-micro). Run as the deploy user with sudo.
set -euo pipefail
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi
# 1 GB RAM: add 2 GB swap so builds and Postgres never get OOM-killed.
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi
mkdir -p ~/retarget-erp-v2
echo "Ready. Put deploy/.env on the server, then push to main (GitHub Actions deploys)."
