#!/bin/sh
set -eu

backup_dir=/backups
mkdir -p "$backup_dir"
daily="$backup_dir/daily-$(date -u +%Y-%m-%d).dump"
weekly="$backup_dir/weekly-$(date -u +%G-W%V).dump"
temporary="$backup_dir/.backup-$$.tmp"
trap 'rm -f -- "$temporary"' EXIT

if pg_dump --format=custom --file="$temporary"; then
  mv -- "$temporary" "$daily"
  cp -- "$daily" "$weekly"
  date -u +%FT%TZ > "$backup_dir/last-success"
  rm -f -- "$backup_dir/last-error"
  printf 'Backup complete: %s\n' "$(date -u +%FT%TZ)"
else
  date -u +%FT%TZ > "$backup_dir/last-error"
  printf 'Backup failed\n' >&2
  exit 1
fi

for prefix in daily weekly; do
  keep=7
  [ "$prefix" != weekly ] || keep=4
  find "$backup_dir" -maxdepth 1 -type f -name "$prefix-*.dump" -printf '%f\n' |
    sort -r | tail -n "+$((keep + 1))" |
    while IFS= read -r filename; do rm -- "$backup_dir/$filename"; done
done
