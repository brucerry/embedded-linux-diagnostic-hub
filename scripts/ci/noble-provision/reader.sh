#!/bin/sh
set -eu
test "$$" = 1
test "$1" -gt 0 && test "$(id -ru):$(id -u):$(id -g)" = "$1:$1:$2"
test "$(stat -c '%d:%i' /job)" = "$3"
test "$(stat -c '%d:%i' /sdk)" = "$4"
test "$(stat -c '%d:%i' /probe)" = "$5"
test "$(ls -1 /sys/class/net)" = lo
awk 'NR>1 && ($1!="lo" || $2=="00000000") {exit 1}' /proc/net/route
awk '$10!="lo" || ($1 ~ /^0+$/ && $2=="00" && substr($9,length($9)-2,1) !~ /[2367abef]/) {exit 1}' /proc/net/ipv6_route
awk '
  $1=="CapEff:" && $2 ~ /^0+$/ {c=1} $1=="NoNewPrivs:" && $2==1 {n=1}
  $1=="Seccomp:" && $2==2 {s=1} END {exit !(c&&n&&s)}
' /proc/self/status
awk '
  $5=="/" || $5=="/job" || $5=="/sdk" || $5=="/probe" {
    if ($6 !~ /(^|,)ro(,|$)/ || n[$5]++) exit 1
  }
  END {exit !(n["/"]==1 && n["/job"]==1 && n["/sdk"]==1 && n["/probe"]==1)}
' /proc/self/mountinfo
set -- $(stat -f -c '%a %S' /job)
test "$(($1*$2))" -ge 4294967296
dpkg-query -W -f='${Package}\t${Architecture}\t${Version}\t${Status}\n' | sort | cmp -s - /probe/expected-installed
test -z "$(dpkg --audit)"
sha256sum --strict --status --check /probe/native-sha
sha256sum --strict --status --check /probe/header-sha
tab=$(printf '\t')
while IFS="$tab" read -r path mode uid gid kind expect; do
    test "$(stat -c '%a:%u:%g:%F' "$path")" = "$mode:$uid:$gid:$kind"
    if [ "$kind" = 'regular file' ]; then
        test "$(stat -c '%s' "$path")" = "$expect"
    else
        test "$(readlink -- "$path")" = "$expect"
    fi
done < /probe/native-meta
test "$(readlink /usr/bin/cc)" = /etc/alternatives/cc
test "$(readlink /etc/alternatives/cc)" = /usr/bin/gcc
test "$(readlink /usr/bin/gcc)" = gcc-13
test "$(readlink /usr/bin/gcc-13)" = x86_64-linux-gnu-gcc-13
test "$(realpath -e /usr/bin/cc)" = /usr/bin/x86_64-linux-gnu-gcc-13
test ! -e /etc/ld.so.preload && test ! -L /etc/ld.so.preload
test "$(realpath -e /lib64/ld-linux-x86-64.so.2)" = /usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2
sha256sum --strict --status --check /probe/ldconfig-sha
test "$(stat -c '%u:%g:%F' /etc/ld.so.cache)" = '0:0:regular file'
cache=$(/usr/sbin/ldconfig -p)
while IFS="$tab" read -r soname expected; do
    if [ "$soname" = ld-linux-x86-64.so.2 ]; then
        test "$(realpath -e /lib64/ld-linux-x86-64.so.2)" = "$expected"
        continue
    fi
    path=$(printf '%s\n' "$cache" | awk -v name="$soname" '$1==name && /\(libc6,x86-64\)/ {print $NF}')
    test "$path" = "/lib/x86_64-linux-gnu/$soname" || test "$path" = "/usr/lib/x86_64-linux-gnu/$soname"
    test "$(realpath -e "$path")" = "$expected"
done < /probe/cache-targets
printf 'reader-verified %s\n' "$(sha256sum /etc/ld.so.cache | cut -d ' ' -f1)"
