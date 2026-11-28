/* Scoped diagnostic fixture, not a complete descendant census or installer check. */
#if defined(__APPLE__) && defined(__MACH__)
#include <errno.h>
#include <libproc.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/proc_info.h>
#include <sys/wait.h>
#include <unistd.h>

static int wait_clean(pid_t pid) {
    int status = 0;
    pid_t seen;
    do { seen = waitpid(pid, &status, 0); } while (seen < 0 && errno == EINTR);
    return seen == pid && WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

static int stable_child(pid_t target, pid_t owner, struct proc_bsdinfo *saved) {
    struct proc_bsdinfo other = {0};
    const int a = proc_pidinfo(target, PROC_PIDTBSDINFO, 0, saved, (int)sizeof(*saved));
    const int b = proc_pidinfo(target, PROC_PIDTBSDINFO, 0, &other, (int)sizeof(other));
    return a == (int)sizeof(*saved) && b == (int)sizeof(other)
        && saved->pbi_pid == (uint32_t)target && other.pbi_pid == (uint32_t)target
        && saved->pbi_ppid == (uint32_t)owner && other.pbi_ppid == (uint32_t)owner
        && saved->pbi_start_tvsec != 0 && saved->pbi_start_tvusec < 1000000
        && saved->pbi_start_tvsec == other.pbi_start_tvsec
        && saved->pbi_start_tvusec == other.pbi_start_tvusec;
}

static int disappeared(pid_t pid, const struct proc_bsdinfo *saved) {
    struct proc_bsdinfo later = {0};
    const int n = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &later, (int)sizeof(later));
    return n == 0 || (n == (int)sizeof(later) && later.pbi_pid == (uint32_t)pid
        && later.pbi_start_tvsec != 0 && later.pbi_start_tvusec < 1000000
        && (later.pbi_start_tvsec != saved->pbi_start_tvsec
            || later.pbi_start_tvusec != saved->pbi_start_tvusec));
}

int main(int argc, char **argv) {
    (void)argv;
    if (argc != 1 || getuid() == 0 || getuid() != geteuid()) return 2;
    int gate[2], ready[2];
    if (pipe(gate) != 0 || pipe(ready) != 0) return 3;
    alarm(8);
    const pid_t self = getpid(), direct = fork();
    if (direct < 0) return 4;
    if (direct == 0) {
        close(gate[1]);
        close(ready[0]);
        const pid_t intermediate = getpid(), helper = fork();
        if (helper < 0) { close(ready[1]); close(gate[0]); _exit(4); }
        if (helper == 0) {
            close(ready[1]);
            char unused;
            ssize_t n;
            do { n = read(gate[0], &unused, 1); } while (n < 0 && errno == EINTR);
            close(gate[0]);
            _exit(n == 0 ? 0 : 5);
        }
        close(gate[0]);
        struct proc_bsdinfo snapshot = {0};
        const char good = stable_child(helper, intermediate, &snapshot) ? '1' : '0';
        ssize_t sent;
        do { sent = write(ready[1], &good, 1); } while (sent < 0 && errno == EINTR);
        close(ready[1]);
        const int waited = wait_clean(helper);
        _exit(sent == 1 && good == '1' && waited && disappeared(helper, &snapshot) ? 0 : 6);
    }

    close(gate[0]);
    close(ready[1]);
    char ready_value = 0;
    ssize_t got;
    do { got = read(ready[0], &ready_value, 1); } while (got < 0 && errno == EINTR);
    close(ready[0]);
    struct proc_bsdinfo snapshot = {0};
    const int stable = got == 1 && ready_value == '1' && stable_child(direct, self, &snapshot);
    close(gate[1]);
    const int waited = wait_clean(direct);
    alarm(0);
    if (!stable || !waited || !disappeared(direct, &snapshot)) {
        fputs("registered fixture chain incomplete\n", stderr);
        return 7;
    }
    puts("{\"scope\":\"registered-test-chain\",\"ownedEdges\":2,"
         "\"parentWaits\":2,\"registeredInstancesRetired\":true,"
         "\"descendantCoverage\":\"registered-only\",\"productionQualified\":false}");
    return 0;
}
#else
#include <stdio.h>
int main(void) { fputs("macOS is required for the registered-tree check\n", stderr); return 1; }
#endif
