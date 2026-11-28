/* Diagnostic fixture only: does not accept an app path, PID or external target. */
#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

static int start_self(const wchar_t *mode, DWORD flags, PROCESS_INFORMATION *pi) {
    wchar_t exe[1024], command[1100];
    const DWORD n = GetModuleFileNameW(NULL, exe, (DWORD)(sizeof(exe) / sizeof(exe[0])));
    if (n == 0 || n >= (DWORD)(sizeof(exe) / sizeof(exe[0])) || wcschr(exe, L'"')) return 0;
    if (swprintf_s(command, sizeof(command) / sizeof(command[0]), L"\"%ls\" %ls", exe, mode) < 0) return 0;
    STARTUPINFOW si = {0};
    si.cb = (DWORD)sizeof(si);
    return CreateProcessW(exe, command, NULL, NULL, FALSE, flags, NULL, NULL, &si, pi) != 0;
}

static int exited_normally(HANDLE process, DWORD milliseconds) {
    DWORD status = 1;
    return WaitForSingleObject(process, milliseconds) == WAIT_OBJECT_0
        && GetExitCodeProcess(process, &status) && status == 0;
}

int wmain(int argc, wchar_t **argv) {
    if (argc == 2 && wcscmp(argv[1], L"--fixture-helper") == 0) {
        Sleep(100);
        return 0;
    }
    if (argc == 2 && wcscmp(argv[1], L"--fixture-owner") == 0) {
        PROCESS_INFORMATION helper = {0};
        if (!start_self(L"--fixture-helper", 0, &helper)) return 10;
        CloseHandle(helper.hThread);
        const int clean = exited_normally(helper.hProcess, 5000);
        CloseHandle(helper.hProcess);
        return clean ? 0 : 11;
    }
    if (argc != 1) return 2;

    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (job == NULL) return 3;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, (DWORD)sizeof(limits))) {
        CloseHandle(job);
        return 4;
    }
    PROCESS_INFORMATION owner = {0};
    if (!start_self(L"--fixture-owner", CREATE_SUSPENDED, &owner)) {
        CloseHandle(job);
        return 5;
    }
    int result = 6;
    BOOL member = FALSE;
    if (!AssignProcessToJobObject(job, owner.hProcess)) {
        TerminateProcess(owner.hProcess, 6); /* Only a child opened by this fixture. */
        WaitForSingleObject(owner.hProcess, 3000);
    } else if (IsProcessInJob(owner.hProcess, job, &member) && member
               && ResumeThread(owner.hThread) == 1 && exited_normally(owner.hProcess, 8000)) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {0};
        if (QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                      &accounting, (DWORD)sizeof(accounting), NULL)
                && accounting.TotalProcesses == 2 && accounting.ActiveProcesses == 0) {
            puts("{\"scope\":\"owned-test-job-only\",\"totalProcesses\":2,\"activeProcesses\":0,"
                 "\"ownerExitedNormally\":true,\"productionQualified\":false}");
            result = 0;
        }
    }
    CloseHandle(owner.hThread);
    CloseHandle(owner.hProcess);
    CloseHandle(job);
    if (result != 0) fputs("Windows owned job observation incomplete\n", stderr);
    return result;
}
#else
#include <stdio.h>
int main(void) { fputs("Windows is required for the owned job check\n", stderr); return 1; }
#endif
