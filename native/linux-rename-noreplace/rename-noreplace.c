/* Source-only draft: no binary has been built or qualified. Borrowed FDs are never closed. */
#if !defined(__linux__) || !defined(__x86_64__)
#error "Diagnostic Hub no-replace binding requires native Linux x64"
#else
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#ifndef NAPI_VERSION
#define NAPI_VERSION 8
#endif
#if NAPI_VERSION != 8
#error "Diagnostic Hub binding ABI requires Node-API 8"
#endif
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/fs.h>
#include <math.h>
#include <stdint.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
#if !defined(SYS_renameat2) || !defined(RENAME_NOREPLACE)
#error "Linux headers must expose renameat2 and RENAME_NOREPLACE; no fallback exists"
#endif
_Static_assert(sizeof(void*) == 8, "Linux x64 pointer size required");

enum dh_rename_status {
    DH_OK = 0, DH_EXISTS = 1, DH_UNSUPPORTED = 2, DH_PERMISSION = 3,
    DH_CROSS_DEVICE = 4, DH_ARGUMENT = 5, DH_BAD_FD = 6, DH_UNKNOWN = 7,
    DH_INTERRUPTED = 8, DH_READ_ONLY = 9, DH_BUSY = 10
};
static napi_value result(napi_env env, enum dh_rename_status status) {
    napi_value value;
    if (napi_create_int32(env, (int32_t)status, &value) != napi_ok) {
        napi_throw_error(env, "ERR_DH_RENAME_NAPI", "No-replace result unavailable");
        return NULL;
    }
    return value;
}
static int descriptor(napi_env env, napi_value value, int* output) {
    double number;
    if (napi_get_value_double(env, value, &number) != napi_ok || !isfinite(number) ||
        number < 0 || number > INT_MAX) return 0;
    *output = (int)number;
    return (double)*output == number;
}
static int basename_utf8(napi_env env, napi_value value, char output[256]) {
    char16_t units[256];
    size_t length = 0, written = 0, bytes = 0;
    if (napi_get_value_string_utf16(env, value, NULL, 0, &length) != napi_ok ||
        length == 0 || length > 255 ||
        napi_get_value_string_utf16(env, value, units, 256, &written) != napi_ok ||
        written != length) return 0;
    for (size_t at = 0; at < length; at++) {
        uint16_t unit = units[at];
        if (unit < 32 || unit == 127 || unit == '/' || unit == '\\') return 0;
        if (unit >= 0xd800 && unit <= 0xdbff) {
            if (++at >= length || units[at] < 0xdc00 || units[at] > 0xdfff) return 0;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) return 0;
    }
    if (napi_get_value_string_utf8(env, value, NULL, 0, &bytes) != napi_ok ||
        bytes == 0 || bytes > 255 ||
        napi_get_value_string_utf8(env, value, output, 256, &written) != napi_ok ||
        written != bytes || strlen(output) != bytes) return 0;
    return strcmp(output, ".") != 0 && strcmp(output, "..") != 0;
}
static enum dh_rename_status error_status(int code) {
    switch (code) {
        case EEXIST: case ENOTEMPTY: return DH_EXISTS;
        case ENOSYS: case EINVAL: case EOPNOTSUPP: return DH_UNSUPPORTED;
        case EACCES: case EPERM: return DH_PERMISSION;
        case EXDEV: return DH_CROSS_DEVICE;
        case ENAMETOOLONG: return DH_ARGUMENT;
        case EBADF: case ENOTDIR: return DH_BAD_FD;
        case EINTR: return DH_INTERRUPTED;
        case EROFS: return DH_READ_ONLY;
        case EBUSY: return DH_BUSY;
        default: return DH_UNKNOWN;
    }
}
static napi_value rename_noreplace(napi_env env, napi_callback_info info) {
    napi_value argv[5]; size_t argc = 5;
    int source = -1, target = -1;
    char source_name[256], target_name[256];
    struct stat before_source, before_target;
    if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 4 ||
        !descriptor(env, argv[0], &source) || !descriptor(env, argv[2], &target) ||
        !basename_utf8(env, argv[1], source_name) || !basename_utf8(env, argv[3], target_name))
        return result(env, DH_ARGUMENT);
    const uid_t uid = getuid();
    if (uid == 0 || uid != geteuid()) return result(env, DH_PERMISSION);
    if (fstat(source, &before_source) != 0 || fstat(target, &before_target) != 0)
        return result(env, DH_BAD_FD);
    if (!S_ISDIR(before_source.st_mode) || !S_ISDIR(before_target.st_mode) ||
        before_source.st_nlink == 0 || before_target.st_nlink == 0 ||
        before_source.st_uid != uid || before_target.st_uid != uid ||
        (before_source.st_mode & (S_IWGRP | S_IWOTH | S_ISUID | S_ISGID | S_ISVTX)) != 0 ||
        (before_target.st_mode & (S_IWGRP | S_IWOTH | S_ISUID | S_ISGID | S_ISVTX)) != 0)
        return result(env, DH_PERMISSION);
    const int source_flags = fcntl(source, F_GETFD), target_flags = fcntl(target, F_GETFD);
    if (source_flags < 0 || target_flags < 0 || (source_flags & FD_CLOEXEC) == 0 ||
        (target_flags & FD_CLOEXEC) == 0) return result(env, DH_BAD_FD);
    if (before_source.st_dev == before_target.st_dev && before_source.st_ino == before_target.st_ino &&
        strcmp(source_name, target_name) == 0) return result(env, DH_ARGUMENT);
    /* Exactly one move attempt. Never retry EINTR or replace a destination. */
    const long moved = syscall(SYS_renameat2, source, source_name, target, target_name, RENAME_NOREPLACE);
    const int saved_errno = errno;
    if (moved == 0) return result(env, DH_OK);
    return result(env, moved == -1 ? error_status(saved_errno) : DH_UNKNOWN);
}
static napi_value initialize(napi_env env, napi_value exports) {
    napi_value abi, api, statuses, platform, arch, method;
    if (napi_create_int32(env, 1, &abi) != napi_ok || napi_create_int32(env, 8, &api) != napi_ok ||
        napi_create_int32(env, 1, &statuses) != napi_ok ||
        napi_create_string_utf8(env, "linux", NAPI_AUTO_LENGTH, &platform) != napi_ok ||
        napi_create_string_utf8(env, "x64", NAPI_AUTO_LENGTH, &arch) != napi_ok ||
        napi_create_function(env, "renameNoReplace", NAPI_AUTO_LENGTH, rename_noreplace, NULL, &method) != napi_ok) {
        napi_throw_error(env, "ERR_DH_RENAME_NAPI", "No-replace initialization unavailable");
        return NULL;
    }
    const napi_property_descriptor properties[] = {
        { "abiVersion", NULL, NULL, NULL, NULL, abi, napi_enumerable, NULL },
        { "napiVersion", NULL, NULL, NULL, NULL, api, napi_enumerable, NULL },
        { "statusVersion", NULL, NULL, NULL, NULL, statuses, napi_enumerable, NULL },
        { "platform", NULL, NULL, NULL, NULL, platform, napi_enumerable, NULL },
        { "arch", NULL, NULL, NULL, NULL, arch, napi_enumerable, NULL },
        { "renameNoReplace", NULL, NULL, NULL, NULL, method, napi_enumerable, NULL }
    };
    if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok ||
        napi_object_freeze(env, exports) != napi_ok) {
        napi_throw_error(env, "ERR_DH_RENAME_NAPI", "No-replace exports unavailable");
        return NULL;
    }
    return exports;
}
NAPI_MODULE(diagnostic_hub_rename_noreplace, initialize)
#endif
