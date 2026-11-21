#!/bin/sh
set -eu
test "$$" = 1
test "$(id -u)" = "$EXPECTED_UID"
test "$(id -g)" = "$EXPECTED_GID"
test "$(awk 'NR>2 {gsub(":","",$1); print $1}' /proc/net/dev)" = lo
awk 'NR>1 && ($1!="lo" || $2=="00000000") {exit 1}' /proc/net/route
awk '$10!="lo" || ($1 ~ /^0+$/ && $2=="00" && substr($9,length($9)-2,1) !~ /[2367abef]/) {exit 1}' /proc/net/ipv6_route
awk '$1=="NoNewPrivs:" && $2==1 {n=1} $1=="Seccomp:" && $2==2 {s=1} $1=="CapEff:" && $2 ~ /^0+$/ {c=1} END {exit !(n&&s&&c)}' /proc/self/status
awk '$5=="/" && $6 ~ /^ro(,|$)/ {root=1} $5=="/staged" && $6 ~ /^ro(,|$)/ {stage=1} END {exit !(root&&stage)}' /proc/self/mountinfo
test "$(stat -c '%a %u %g' /scratch)" = "700 $EXPECTED_UID $EXPECTED_GID"
cd /staged
sha256sum --strict --status --check census
sha256sum --strict --status --check loader-pins
ld_report="$(env -i LANG=C.UTF-8 /lib64/ld-linux-x86-64.so.2 --list /staged/bin/node)"
printf '%s\n' "$ld_report" | awk '
    NF==2 && $1=="linux-vdso.so.1" {v++; next}
    NF==4 && $2=="=>" && $3 ~ /^\// {print $1, $3; next}
    NF==2 && $1 ~ /^\// {print "ld-linux-x86-64.so.2", $1; next}
    {exit 1}
    END {if (v!=1) exit 1}
' > /scratch/loader-paths
while read -r name path; do
    printf '%s %s\n' "$name" "$(readlink -f "$path")"
done < /scratch/loader-paths | LC_ALL=C sort > /scratch/loader-actual
cmp -s /scratch/loader-actual loader-map
exec env -i PATH=/usr/bin:/bin LANG=C.UTF-8 HOME=/scratch TMPDIR=/scratch NODE_DISABLE_COMPILE_CACHE=1 /staged/bin/node /staged/startup.cjs
