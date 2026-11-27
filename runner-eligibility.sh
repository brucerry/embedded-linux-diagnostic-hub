#!/bin/sh
# Read-only preflight. Does not create a unit or touch any product bytes.
set -eu
name=$(/usr/bin/systemctl --version | /usr/bin/sed -n '1p')
case "$name" in
    'systemd '*) ;;
    *) printf '%s\n' 'Unsupported systemd version format' >&2; exit 78 ;;
esac
set -- $name
case "${2:-}" in
    ''|*[!0-9]*) printf '%s\n' 'Unknown systemd version' >&2; exit 78 ;;
esac
printf 'systemd_major=%s\n' "$2"
printf 'cgroup_fs=%s\n' "$(/usr/bin/stat -f -c %T /sys/fs/cgroup)"
if [ "$2" -lt 250 ] || [ "$(/usr/bin/stat -f -c %T /sys/fs/cgroup)" != cgroup2fs ]; then
    printf '%s\n' 'unsupported_baseline_no_process_launched'
    exit 78
fi
printf '%s\n' 'baseline_compatible_not_containment_proof'
