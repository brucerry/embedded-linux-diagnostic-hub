#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <poll.h>
#include <pty.h>
#include <pwd.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Inert checks only. Exit codes are translated by the workflow into fixed labels. */
static int ancestors(const char *path, uid_t uid) {
    char current[256], resolved[4096];
    if (!path || path[0] != '/' || strlen(path) >= sizeof current) return 0;
    for (size_t i = 1; ; i++) {
        if (path[i] && path[i] != '/') continue;
        memcpy(current, path, i);
        current[i] = 0;
        struct stat found;
        if (lstat(current, &found) || !S_ISDIR(found.st_mode) || !found.st_ino ||
            found.st_ino > UINT64_C(9007199254740991) || (found.st_mode & 07022) ||
            (found.st_uid != 0 && found.st_uid != uid) ||
            (!strncmp(current, "/home/ubuntu", 12) && found.st_uid != uid) ||
            !realpath(current, resolved) || strcmp(current, resolved)) return 0;
        if (!path[i]) return 1;
    }
}

static int isolated_loopback(void) {
    struct ifaddrs *interfaces;
    if (getifaddrs(&interfaces)) return 0;
    int present = 0, safe = 1;
    for (struct ifaddrs *row = interfaces; row; row = row->ifa_next) {
        if (strcmp(row->ifa_name, "lo") || !(row->ifa_flags & IFF_LOOPBACK)) safe = 0;
        if (row->ifa_addr && row->ifa_addr->sa_family == AF_INET) present = 1;
    }
    freeifaddrs(interfaces);
    return safe && present;
}

static int same(int fd, const char *name, const struct stat *before) {
    struct stat after;
    return !fstatat(fd, name, &after, AT_SYMLINK_NOFOLLOW) &&
           before->st_dev == after.st_dev && before->st_ino == after.st_ino;
}

static int rename_probe(int fd) {
    struct stat source, occupied, absent;
    /* Two empty test directories inside a freshly allocated private prefix. */
    if (mkdirat(fd, "source", 0700) || mkdirat(fd, "occupied", 0700) ||
        fstatat(fd, "source", &source, AT_SYMLINK_NOFOLLOW) ||
        fstatat(fd, "occupied", &occupied, AT_SYMLINK_NOFOLLOW) ||
        source.st_dev != occupied.st_dev) return 0;
    if (syscall(SYS_renameat2, fd, "source", fd, "occupied", 1U) != -1 || errno != EEXIST ||
        !same(fd, "source", &source) || !same(fd, "occupied", &occupied)) return 0;
    if (syscall(SYS_renameat2, fd, "source", fd, "moved", 1U) || !same(fd, "moved", &source) ||
        fstatat(fd, "source", &absent, AT_SYMLINK_NOFOLLOW) != -1 || errno != ENOENT) return 0;
    return 1;
}

static int pty_probe(void) {
    int master, status = 0, eof = 0, reaped = 0;
    char buffer[16];
    size_t used = 0;
    pid_t child = forkpty(&master, NULL, NULL, NULL);
    if (child < 0) return 0;
    if (child == 0) _exit(write(STDOUT_FILENO, "inert\n", 6) == 6 ? 0 : 1);
    struct timespec start, now;
    if (clock_gettime(CLOCK_MONOTONIC, &start)) goto done;
    while (!eof || !reaped) {
        if (clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_sec - start.tv_sec >= 3) break;
        if (!reaped) {
            pid_t waited = waitpid(child, &status, WNOHANG);
            if (waited == -1) break;
            reaped = waited == child;
        }
        struct pollfd ready = {.fd = master, .events = POLLIN};
        int count = poll(eof ? NULL : &ready, eof ? 0 : 1, 25);
        if (count < 0) break;
        if (!count || eof) continue;
        if (used == sizeof buffer) break;
        ssize_t n = read(master, buffer + used, sizeof buffer - used);
        if (!n || (n < 0 && errno == EIO)) eof = 1;
        else if (n < 0) break;
        else used += (size_t)n;
    }
done:
    if (!reaped) {
        kill(child, SIGKILL); /* The unreaped child is owned by this inert probe. */
        while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
    }
    return close(master) == 0 && eof && reaped && WIFEXITED(status) && !WEXITSTATUS(status) &&
           used == 7 && !memcmp(buffer, "inert\r\n", 7);
}

int main(void) {
    uid_t uid = getuid();
    const char *home = getenv("HOME");
    struct passwd *account = getpwuid(uid);
    if (!uid || uid != geteuid() || !account || !home || strcmp(home, "/home/ubuntu") ||
        strcmp(account->pw_dir, home)) return 10;
    struct stat root;
    if (lstat("/", &root) || !S_ISDIR(root.st_mode) || (root.st_uid != 0 && root.st_uid != uid) ||
        !root.st_ino || root.st_ino > UINT64_C(9007199254740991) || (root.st_mode & 07022) ||
        !ancestors(home, uid)) return 11;
    if (!isolated_loopback()) return 12;
    char prefix[] = "/home/ubuntu/hub-host-probe.XXXXXXXX";
    if (!mkdtemp(prefix)) return 13;
    int fd = open(prefix, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    struct stat st;
    int result = 13;
    if (fd >= 0) {
        if (ancestors(prefix, uid) && !fstat(fd, &st) && st.st_uid == uid &&
            (st.st_mode & 07777) == 0700) result = !rename_probe(fd) ? 14 : !pty_probe() ? 15 : 0;
        for (const char **name = (const char *[]){"source", "occupied", "moved", NULL}; *name; name++)
            if (unlinkat(fd, *name, AT_REMOVEDIR) && errno != ENOENT && !result) result = 16;
        if (close(fd) && !result) result = 16;
    }
    if (rmdir(prefix) && !result) result = 16;
    if (!result) puts("linux-folder-host=pass");
    return result;
}
