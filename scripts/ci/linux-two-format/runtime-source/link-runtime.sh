#!/bin/bash
set -euo pipefail
umask 077
prior="$build_root"
. "$build_root/squash-env.sh"
cd "$build_root"
sha256sum -c "$build_root/BUILD-INPUTS.sha256" --status
libfuse_inc="$work/addons/usr/include/fuse3"
libfuse_lib="$work/addons/usr/lib/x86_64-linux-musl"
stage="$work/runtime"
mkdir -p "$stage/include/squashfuse"
cp -- "$prior/candidate/runtime.c" "$prior/upstream/data_sections.ld" "$stage/"
cp -- "$work/squashfuse-0.5.2"/*.h "$stage/include/squashfuse/"
cd "$stage"
# Match the upstream target flags. The label binds the patched source instead of impersonating upstream.
label=https://github.com/AppImage/type2-runtime/commit/dd6cebedcbddde9c82f89b011e8e1d40b6e43868+hub-cleanup.3f9c9b19fbf4
"$CC" -Iinclude -Iinclude/squashfuse -I"$libfuse_inc" -std=gnu99 -Os -D_FILE_OFFSET_BITS=64 \
 "-DGIT_COMMIT=\"$label\"" -T data_sections.ld -ffunction-sections -fdata-sections -Wl,--gc-sections \
 -static -Wall -Werror -static-pie "-ffile-prefix-map=$work=." "-ffile-prefix-map=$root=./alpine-sysroot" \
 -L"$work/squashfuse-0.5.2/.libs" -L"$libfuse_lib" -Wl,-Map,link-map.txt \
 runtime.c -lsquashfuse -lsquashfuse_ll -lzstd -lz -lfuse3 -lmimalloc -o runtime-x86_64
objcopy --only-keep-debug runtime-x86_64 runtime-x86_64.debug
strip --strip-debug --strip-unneeded runtime-x86_64
objcopy --add-gnu-debuglink runtime-x86_64.debug runtime-x86_64
printf 'AI\002' | dd of=runtime-x86_64 bs=1 count=3 seek=8 conv=notrunc status=none
sha256sum runtime-x86_64 runtime-x86_64.debug
readelf -W -h -l -S -n -d runtime-x86_64 > "$work/ELF.txt"
