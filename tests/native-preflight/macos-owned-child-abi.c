/* Owned-child ABI check only. Never accepts a PID, scans the host, or qualifies an installer. */
#if defined(__APPLE__) && defined(__MACH__)
#include <errno.h>
#include <libproc.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/proc_info.h>
#include <sys/wait.h>
#include <unistd.h>

static int detail(pid_t child, struct proc_bsdinfo *out) {
    return proc_pidinfo(child, PROC_PIDTBSDINFO, 0, out, (int)sizeof(*out));
}

int main(int argc, char **argv) {
    (void)argv;
    if (argc != 1 || getuid() == 0 || getuid() != geteuid()) return 2;
    int gate[2];
    if (pipe(gate) != 0) return 3;
    alarm(8);
    const pid_t parent = getpid(), child = fork();
    if (child < 0) { close(gate[0]); close(gate[1]); return 4; }
    if (child == 0) {
        close(gate[1]);
        char ignored;
        ssize_t count;
        do { count = read(gate[0], &ignored, 1); } while (count < 0 && errno == EINTR);
        close(gate[0]);
        _exit(count == 0 ? 0 : 5);
    }

    close(gate[0]);
    struct proc_bsdinfo a = {0}, b = {0}, later = {0};
    const int first = detail(child, &a), second = detail(child, &b);
    const int normalized = first == (int)sizeof(a) && second == (int)sizeof(b)
        && a.pbi_pid == (uint32_t)child && b.pbi_pid == (uint32_t)child
        && a.pbi_ppid == (uint32_t)parent && b.pbi_ppid == (uint32_t)parent
        && a.pbi_start_tvsec != 0 && a.pbi_start_tvusec < 1000000
        && a.pbi_start_tvsec == b.pbi_start_tvsec && a.pbi_start_tvusec == b.pbi_start_tvusec;

    close(gate[1]);
    int status = 0;
    pid_t seen;
    do { seen = waitpid(child, &status, 0); } while (seen < 0 && errno == EINTR);
    const int clean_exit = seen == child && WIFEXITED(status) && WEXITSTATUS(status) == 0;
    const int after = clean_exit ? detail(child, &later) : -1;
    alarm(0);
    const int gone = after == 0;
    const int reused = after == (int)sizeof(later) && later.pbi_pid == (uint32_t)child
        && later.pbi_start_tvsec != 0 && later.pbi_start_tvusec < 1000000
        && (later.pbi_start_tvsec != a.pbi_start_tvsec || later.pbi_start_tvusec != a.pbi_start_tvusec);
    if (!normalized || !clean_exit || !(gone || reused)) {
        fputs("owned-process observation failed or incomplete\n", stderr);
        return 6;
    }
    printf("{\"scope\":\"owned-child-abi-preflight\",\"detailBytes\":%zu,"
           "\"stableParentAndBirth\":true,\"waitpidReaped\":true,"
           "\"pidAfterReap\":\"%s\",\"productionQualified\":false}\n",
           sizeof(a), gone ? "not_observed" : "different_instance");
    return 0;
}
#else
#include <stdio.h>
int main(void) { fputs("macOS is required for the owned-child ABI check\n", stderr); return 1; }
#endif
