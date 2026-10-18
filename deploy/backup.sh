#!/bin/sh
# Nightly Postgres dump with checks. Runs in the "backup" container (postgres:16-alpine).
# - a dump is kept only if it completed (gzip valid, end marker present, not tiny);
# - old dumps are removed only while at least 7 good ones remain;
# - on the 1st of each month the newest dump is restored into a scratch database to prove it works.
set -u
DIR=/backups
log() { echo "[backup] $(date -u +%FT%TZ) $*"; }

dump() {
  name="$1"
  tmp="$DIR/.$name.tmp"
  if pg_dump -h db -U erp erp | gzip > "$tmp" \
    && gzip -t "$tmp" \
    && [ "$(stat -c %s "$tmp")" -gt 2048 ] \
    && gunzip -c "$tmp" | tail -n 5 | grep -q 'PostgreSQL database dump complete'; then
    mv "$tmp" "$DIR/$name"
    log "ok $name $(stat -c %s "$DIR/$name") bytes"
    return 0
  fi
  rm -f "$tmp"
  log "FAILED $name — previous backups kept"
  return 1
}

prune() {
  good=$(ls -1 "$DIR"/erp-*.sql.gz 2>/dev/null | wc -l)
  for f in $(find "$DIR" -name 'erp-*.sql.gz' -mtime +14 | sort); do
    [ "$good" -le 7 ] && break
    rm -f "$f" && good=$((good - 1)) && log "removed $f"
  done
  find "$DIR" -name 'pre-deploy-*.sql.gz' -mtime +7 -delete
}

restore_check() {
  latest=$(ls -1t "$DIR"/erp-*.sql.gz 2>/dev/null | head -n 1)
  [ -n "$latest" ] || return 0
  psql -h db -U erp -d postgres -qc 'drop database if exists restore_check' && psql -h db -U erp -d postgres -qc 'create database restore_check' || return 1
  if gunzip -c "$latest" | psql -h db -U erp -d restore_check -q -v ON_ERROR_STOP=1 >/dev/null; then
    n=$(psql -h db -U erp -d restore_check -tAc 'select count(*) from tasks')
    log "restore check ok: $latest ($n tasks)"
  else
    log "RESTORE CHECK FAILED: $latest"
  fi
  psql -h db -U erp -d postgres -qc 'drop database if exists restore_check'
}

if [ "${1:-}" = "once" ]; then dump "pre-deploy-$(date +%F-%H%M%S).sql.gz"; exit $?; fi
while true; do
  dump "erp-$(date +%F).sql.gz" && prune
  [ "$(date +%d)" = "01" ] && restore_check
  sleep 86400
done
