root=$(cat "$build_root/alpine/SYSROOT-PATH.txt")
tools="$build_root/local-bin"
export PATH="$tools:/usr/bin:/bin"
export PERL5LIB="$root/usr/share/autoconf:$root/usr/share/automake-1.17:$root/usr/share/perl5/core_perl:$root/usr/lib/perl5/core_perl"
export autom4te_perllibdir="$root/usr/share/autoconf"
export AC_MACRODIR="$root/usr/share/autoconf" AUTOM4TE_CFG="$tools/autom4te.cfg"
export AUTOMAKE_UNINSTALLED=1 AUTOMAKE_LIBDIR="$root/usr/share/automake-1.17"
export ACLOCAL_PATH="$root/usr/share/aclocal" M4="$tools/m4"
export AUTOCONF="$tools/autoconf" AUTOHEADER="$tools/autoheader" AUTOM4TE="$tools/autom4te" AUTOMAKE="$tools/automake" ACLOCAL="$tools/aclocal" LIBTOOLIZE="$tools/libtoolize"
export HOME="$work" TMPDIR="$work" TZ=UTC LANG=C LC_ALL=C SOURCE_DATE_EPOCH=1762557355
export CC="$tools/clang" AR="$tools/ar" RANLIB="$tools/ranlib" PKG_CONFIG="$tools/pkg-config"
export trailer_m4="$root/usr/share/autoconf/autoconf/trailer.m4"
