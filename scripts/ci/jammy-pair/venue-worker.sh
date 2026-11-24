#!/bin/bash
# Fixed worker on the pinned official Ubuntu runtime. No installer or host work.
set -euo pipefail
export LC_ALL=C
case "$1" in prepare|boot) phase=$1 ;; *) exit 1 ;; esac
report() {
    if test "$phase" = prepare; then
        printf '%s\n' "$1"
    fi
}
report WORKER_STARTED
ulimit -c 0
test "$(id -u)" -gt 0
test "$(id -u)" = "$(/usr/bin/id -ru)"
test "$(uname -m)" = x86_64
test ! -e /dev/kvm
test ! -s /etc/ld.so.preload
set -- "$1" /sys/class/net/*
test "$#" = 2 && test "$2" = /sys/class/net/lo
report WORKER_IDENTITY
awk '
    $5 == "/"     && $6 ~ /(^|,)ro(,|$)/ { root=1 }
    $5 == "/fixture" && $6 ~ /(^|,)ro(,|$)/ { fixture=1 }
    $5 == "/input" && $6 ~ /(^|,)ro(,|$)/ { input=1 }
    $5 == "/work" && $6 ~ /(^|,)rw(,|$)/ { work=1 }
    END { exit !(root && fixture && input && work) }
' /proc/self/mountinfo
awk '
    $1=="CapEff:" && $2=="0000000000000000" { cap=1 }
    $1=="NoNewPrivs:" && $2=="1" { nnp=1 }
    $1=="Seccomp:" && $2=="2" { seccomp=1 }
    END { exit !(cap && nnp && seccomp) }
' /proc/self/status
report WORKER_ISOLATION
sha256sum --check --strict --status /fixture/SHA256SUMS
sha256sum --check --strict --status /input/SHA256SUMS
report WORKER_SEALS
source /fixture/venue-loader.sh
loader=/fixture/lib/ld-linux-x86-64.so.2

tool() {
    local seconds=$1 name=$2
    shift 2
    env -i HOME=/nonexistent PATH=/usr/bin:/bin LC_ALL=C QEMU_MODULE_DIR=/fixture/modules \
        timeout --kill-after=2s "${seconds}s" "$loader" --inhibit-cache --library-path /fixture/lib \
        "/fixture/bin/$name" "$@"
}

check_map() {
    local name=$1 rows
    rows=$(env -i HOME=/nonexistent PATH=/usr/bin:/bin LC_ALL=C \
        timeout --kill-after=2s 8s "$loader" --inhibit-cache --library-path /fixture/lib \
        --list "/fixture/bin/$name" | head -c 32769)
    report "TOOL_${name}_LISTED"
    verify_map "/fixture/$name.map" "$rows"
    report "TOOL_${name}_MAPPED"
}

if test "$phase" = prepare; then
    test ! -e /work/seed.iso && test ! -e /work/disk.qcow2 && test ! -e /work/vars.fd
    report WORKER_READY
    check_map genisoimage
    check_map isoinfo
    check_map qemu-img
    check_map qemu-system-x86_64
    tool 16 genisoimage -quiet -input-charset utf-8 -volid CIDATA -joliet -rock -graft-points \
        -o /work/seed.iso meta-data=/input/meta-data user-data=/input/user-data
    tool 5 isoinfo -i /work/seed.iso -d | grep -xq 'Volume id: CIDATA'
    test "$(tool 5 isoinfo -i /work/seed.iso -R -f | sort)" = "$(printf '/meta-data\n/user-data')"
    for name in meta-data user-data; do
        tool 5 isoinfo -i /work/seed.iso -R -x "/$name" | cmp -s - "/input/$name"
    done
    printf '%s\n' SEED_PASS
    tool 10 qemu-img create -q -f qcow2 -F qcow2 -b /input/jammy.qcow2 /work/disk.qcow2 7516192768
    tool 8 qemu-img info --output=json --backing-chain /work/disk.qcow2 > /work/chain.json
    cp -- /fixture/firmware/OVMF_VARS_4M.fd /work/vars.fd
    chmod 0600 -- /work/vars.fd
    printf '%s\n' OVERLAY_PASS
    exit 0
fi

sha256sum --check --strict --status /work/READONLY.SHA256
test -w /work/vars.fd && test "$(stat -c '%a' -- /work/vars.fd)" = 600
check_map qemu-system-x86_64
test ! -e /work/runtime-gate.sock && test ! -L /work/runtime-gate.sock
umask 077
printf '%s\n' HUB_QEMU_READY_TO_EXEC
exec env -i HOME=/nonexistent PATH=/usr/bin:/bin LC_ALL=C QEMU_MODULE_DIR=/fixture/modules \
    "$loader" --inhibit-cache --library-path /fixture/lib /fixture/bin/qemu-system-x86_64 \
    -name hub-jammy-venue -machine q35,accel=tcg -cpu max -smp 2 -m 2048 -nic none -nodefaults \
    -no-user-config -display none -monitor none -serial stdio -no-reboot -L /fixture/pc-bios \
    -drive if=pflash,unit=0,format=raw,readonly=on,file=/fixture/firmware/OVMF_CODE_4M.fd \
    -drive if=pflash,unit=1,format=raw,file=/work/vars.fd \
    -blockdev '{"driver":"file","node-name":"basefile","filename":"/input/jammy.qcow2","read-only":true}' \
    -blockdev '{"driver":"qcow2","node-name":"base","file":"basefile","backing":null,"read-only":true}' \
    -blockdev '{"driver":"file","node-name":"overlayfile","filename":"/work/disk.qcow2"}' \
    -blockdev '{"driver":"qcow2","node-name":"system","file":"overlayfile","backing":"base"}' \
    -device virtio-blk-pci,drive=system,bootindex=1 \
    -drive if=none,id=cidata,format=raw,media=cdrom,readonly=on,file=/input/seed.iso \
    -device ide-cd,drive=cidata,bus=ide.1 \
    -drive if=none,id=product,format=raw,media=cdrom,readonly=on,file=/input/product.iso \
    -device ide-cd,drive=product,bus=ide.2 \
    -drive if=none,id=apt-display,format=raw,media=cdrom,readonly=on,file=/input/apt-display.iso \
    -device ide-cd,drive=apt-display,bus=ide.3 \
    -drive if=none,id=apt-runtime,format=raw,media=cdrom,readonly=on,file=/input/apt-runtime.iso \
    -device ide-cd,drive=apt-runtime,bus=ide.4 \
    -drive if=none,id=observer,format=raw,media=cdrom,readonly=on,file=/input/observer.iso \
    -device ide-cd,drive=observer,bus=ide.5 \
    -chardev socket,id=hubgate,path=/work/runtime-gate.sock,server=on,wait=off \
    -device virtio-serial-pci,id=hubserial \
    -device virtserialport,bus=hubserial.0,chardev=hubgate,name=org.hub.runtime-preflight
