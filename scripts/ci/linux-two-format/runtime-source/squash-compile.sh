#!/bin/bash
set -euo pipefail
. "$build_root/squash-env.sh"
cd "$work/squashfuse-0.5.2"
/bin/sh autogen.sh > "$work/squash-autogen.txt" 2>&1 || { tail -24 "$work/squash-autogen.txt"; exit 1; }
mkdir -p "$work/fuse-pc"
sed "s@^prefix=/usr\$@prefix=$work/addons/usr@" "$work/fuse-build/meson-private/fuse3.pc" > "$work/fuse-pc/fuse3.pc"
export PKG_CONFIG_LIBDIR="$work/fuse-pc:$root/usr/lib/pkgconfig:$root/usr/share/pkgconfig"
pkg-config --static --libs --cflags fuse3
CFLAGS="-ffunction-sections -fdata-sections -Os -ffile-prefix-map=$work=. -ffile-prefix-map=$root=./alpine-sysroot" LDFLAGS=-static ./configure --prefix=/usr/local > "$work/squash-configure.txt" 2>&1 || { tail -35 "$work/squash-configure.txt"; exit 1; }
tail -22 "$work/squash-configure.txt"
make -j2 libsquashfuse.la libsquashfuse_ll.la > "$work/squash-build.txt" 2>&1 || { tail -35 "$work/squash-build.txt"; exit 1; }
ls -l .libs/*.a
