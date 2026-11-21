#!/bin/sh
set -eu
test "$$" = 1
test "$(id -ru):$(id -u):$(id -g)" = 0:0:0
test "$(stat -c '%d:%i' /approved)" = "$1"
test "$(stat -c '%d:%i' /policy)" = "$2"
shift 2
test "$#" = 39
test "$(ls -1 /sys/class/net)" = lo
awk 'NR>1 && ($1!="lo" || $2=="00000000") {exit 1}' /proc/net/route
awk '$10!="lo" || ($1 ~ /^0+$/ && $2=="00" && substr($9,length($9)-2,1) !~ /[2367abef]/) {exit 1}' /proc/net/ipv6_route
awk '$1=="NoNewPrivs:" && $2==1 {n=1} $1=="Seccomp:" && $2==2 {s=1} END {exit !(n&&s)}' /proc/self/status
awk '
  $5=="/approved" || $5=="/policy" {if ($6 !~ /(^|,)ro(,|$)/ || n[$5]++) exit 1}
  $5=="/" {if ($6 !~ /(^|,)rw(,|$)/ || n[$5]++) exit 1}
  $5=="/dev/shm" {if ($6 !~ /(^|,)rw(,|$)/ || $(NF-2)!="tmpfs" || n[$5]++) exit 1}
  END {exit !(n["/"]==1 && n["/approved"]==1 && n["/policy"]==1 && n["/dev/shm"]==1)}
' /proc/self/mountinfo
test "$(stat -f -c '%b %S' /dev/shm)" = '16384 4096'
sha256sum --strict --status --check /policy/base-pins
cmp -s /usr/sbin/policy-rc.d /policy/policy-rc.d.expected
test ! -e /run/systemd/system && test ! -e /run/dbus/system_bus_socket && test ! -e /usr/bin/systemctl
test ! -e /var/run/docker.sock
test "$(id -u _apt):$(id -g _apt)" = 42:65534
test ! -s /var/lib/dpkg/triggers/Unincorp
audit=$(dpkg --audit) || exit "$?"
test -z "$audit"
test "$(ls -A /policy/empty)" = ''
config=$(APT_CONFIG=/policy/apt.conf apt-config dump)
for required in 'APT::Sandbox::User "_apt";' 'Dir::Etc::sourcelist "/policy/empty.conf";' \
    'Dir::Etc::sourceparts "/policy/empty";' 'Dir::State::lists "/policy/empty";' \
    'APT::Get::AllowUnauthenticated "false";'; do
    printf '%s\n' "$config" | grep -Fxq "$required"
done
unset config
test "$(stat -c '%a' /approved)" = 555
printf '%s\n' "$@" | cmp -s - /policy/ordered-paths
setpriv --reuid=42 --regid=65534 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all \
    /bin/sh -ec '
    test "$(id -ru):$(id -u):$(id -g):$(id -G)" = 42:42:65534:65534
    awk '\''$1=="CapEff:" && $2 ~ /^0+$/ {c=1} END {exit !c}'\'' /proc/self/status
    for deb do
        test -f "$deb" && test ! -L "$deb" && test "$(stat -c "%a:%h" "$deb")" = 444:1
    done
    sha256sum --strict --status --check /policy/archives.sha256
    ' read-as-apt "$@"
printf '%s\n' apt-readable
old_paths=$(dpkg-query -L libc6 libc-bin) || exit "$?"
test -n "$old_paths"
sorted_paths=$(printf '%s\n' "$old_paths" | sort -u) || exit "$?"
printf '%s\n' "$sorted_paths" | sed 's/^/old-path /'
scratch=$(mktemp -d /dev/shm/noble-provision.XXXXXXXX)
export TMPDIR="$scratch" APT_CONFIG=/policy/apt.conf DEBIAN_FRONTEND=noninteractive
printf '%s\n' transaction-invoked
/usr/bin/timeout --signal=TERM --kill-after=3s 230s /usr/bin/apt-get \
    --no-download --no-remove --no-install-recommends --assume-yes install "$@"
audit=$(dpkg --audit) || exit "$?"
test -z "$audit"
test ! -s /var/lib/dpkg/triggers/Unincorp
test -z "$(ls -A /var/lib/dpkg/updates)"
cmp -s /usr/sbin/policy-rc.d /policy/policy-rc.d.expected
test ! -e /run/systemd/system && test ! -e /run/dbus/system_bus_socket && test ! -e /usr/bin/systemctl
installed=$(dpkg-query -W -f='${Package}\t${Architecture}\t${Version}\t${Status}\n') || exit "$?"
sorted_installed=$(printf '%s\n' "$installed" | sort) || exit "$?"
printf '%s\n' "$sorted_installed" | cmp -s - /policy/expected-installed
rmdir "$scratch"
printf '%s\n' transaction-verified
