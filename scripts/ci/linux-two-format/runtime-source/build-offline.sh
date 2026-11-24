#!/bin/bash
set -euo pipefail
umask 077
build_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
prior="$build_root"
test "$(id -u)" -ne 0
test "$#" -eq 1
[[ $1 =~ ^[A-Za-z0-9-]+$ ]]
work="$build_root/$1"
mkdir -- "$work"
root=$(cat "$build_root/alpine/SYSROOT-PATH.txt")
export build_root work
. "$build_root/squash-env.sh"
cd "$build_root"
sha256sum -c "$build_root/BUILD-INPUTS.sha256" --status
# Use the audited local copies of both archives. Meson will refuse any wraps that require downloading.
tar -xJf "$build_root/alpine/libfuse.tar.xz" -C "$work"
tar -xzf "$build_root/alpine/squashfuse.tar.gz" -C "$work"
patch -d "$work/fuse-3.15.0" -p1 -i "$prior/upstream/libfuse-mount.c.diff" > "$work/fuse-patch.txt"
PKG_CONFIG_SYSROOT_DIR="$root" PKG_CONFIG_LIBDIR="$root/usr/lib/pkgconfig:$root/usr/share/pkgconfig"  CFLAGS="-ffile-prefix-map=$work=. -ffile-prefix-map=$root=./alpine-sysroot"  meson setup "$work/fuse-build" "$work/fuse-3.15.0" --prefix=/usr --libdir=lib/x86_64-linux-musl --default-library=static  --wrap-mode=nodownload > "$work/fuse-configure.txt" 2>&1
ninja -C "$work/fuse-build" -j2 lib/libfuse3.a > "$work/fuse-build.txt" 2>&1
# Stage only the archive, headers and pkg-config input. No Meson install hook or fusermount binary.
libfuse_inc="$work/addons/usr/include/fuse3"
libfuse_lib="$work/addons/usr/lib/x86_64-linux-musl"
mkdir -p "$libfuse_inc" "$libfuse_lib"
cp -- "$work/fuse-3.15.0"/include/*.h "$work/fuse-build/libfuse_config.h" "$libfuse_inc/"
cp -- "$work/fuse-build/lib/libfuse3.a" "$libfuse_lib/"
bash "$build_root/squash-compile.sh" > "$work/squash-compile.txt" 2>&1
/usr/bin/grep -Eq '^Compression support .*: ZLIB ZSTD$' "$work/squash-configure.txt"
/usr/bin/grep -Eq '^Low-level FUSE driver .*: yes$' "$work/squash-configure.txt"
bash "$build_root/link-runtime.sh"
