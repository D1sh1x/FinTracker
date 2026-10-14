#!/bin/sh
set -eu
trap 'exit 0' TERM INT

while true; do
  /bin/sh /scripts/backup.sh || true
  sleep 86400 &
  wait "$!" || true
done
