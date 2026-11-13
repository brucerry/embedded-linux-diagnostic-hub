"""Read-only classifications for one standard hosted Linux job.

No PTY allocation, display connection, tool execution, package installation,
application/helper/addon loading, process control or lifecycle operation.
Only finite classifications are written to the runner's managed output file.
"""
import json
import os
import pathlib
import re
import shutil
import signal
import stat
import sys

REPOSITORY = 'brucerry/embedded-linux-diagnostic-hub'
BRANCH = 'refs/heads/ci/v060-linux-host-context-20261113'


def require(value):
    if not value:
        raise RuntimeError('Read-only host context unavailable')


def owned_directory(path, uid):
    try:
        value = os.lstat(path)
        return (stat.S_ISDIR(value.st_mode) and value.st_uid == uid and
                value.st_ino > 0 and not value.st_mode & 0o7022 and
                os.path.realpath(path) == path)
    except OSError:
        return False


def tool_available(name, uid):
    selected = shutil.which(name)
    if not selected:
        return False
    try:
        value = os.stat(selected)
        return (stat.S_ISREG(value.st_mode) and value.st_uid in (0, uid) and
                not value.st_mode & 0o7022)
    except OSError:
        return False


def fixed_root_client_available():
    selected = '/usr/bin/xdpyinfo'
    try:
        value = os.lstat(selected)
        return (stat.S_ISREG(value.st_mode) and value.st_uid == 0 and
                not value.st_mode & 0o7022 and os.path.realpath(selected) == selected and
                os.access(selected, os.X_OK))
    except OSError:
        return False


def main():
    require(len(sys.argv) == 1 and sys.platform == 'linux' and
            os.environ.get('GITHUB_REPOSITORY') == REPOSITORY and
            os.environ.get('GITHUB_REF') == BRANCH and
            os.environ.get('GITHUB_RUN_ATTEMPT') == '1' and
            os.environ.get('GITHUB_EVENT_NAME') == 'push' and
            os.environ.get('RUNNER_ENVIRONMENT') == 'github-hosted' and
            os.environ.get('RUNNER_OS') == 'Linux' and
            os.environ.get('RUNNER_ARCH') == 'X64')
    uid, euid = os.getuid(), os.geteuid()
    source = str(pathlib.Path(__file__).resolve().parents[1])
    require(source == os.environ.get('GITHUB_WORKSPACE'))
    head_path = pathlib.Path(source) / '.git/HEAD'
    require(head_path.is_file() and head_path.stat().st_size <= 256)
    head = head_path.read_text(encoding='ascii').strip()
    require(re.fullmatch('[a-f0-9]{40}', head) and head == os.environ.get('GITHUB_SHA'))

    try:
        ptmx = os.stat('/dev/ptmx')
        ptmx_access = stat.S_ISCHR(ptmx.st_mode) and os.access('/dev/ptmx', os.R_OK | os.W_OK)
    except OSError:
        ptmx_access = False
    home = os.environ.get('HOME', '')
    values = {
        'binding': 'verified',
        'identity': 'non-root-matched' if uid > 0 and uid == euid else 'root' if uid == euid == 0 else 'mixed',
        'home': 'owned-safe' if owned_directory(home, uid) else 'not-established',
        'workspace': 'owned-safe' if owned_directory(source, uid) else 'not-established',
        'stdin': 'tty' if os.isatty(0) else 'not-tty',
        'ptmx': 'accessible-character-device' if ptmx_access else 'not-established',
        'devpts': 'mounted' if os.path.ismount('/dev/pts') else 'not-established',
        'display': 'declared' if os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY') else 'unset',
        'xauth_environment': 'declared' if os.environ.get('XAUTHORITY') else 'unset',
        'xvfb_tool': 'present' if tool_available('Xvfb', uid) else 'not-established',
        'xauth_tool': 'present' if tool_available('xauth', uid) else 'not-established',
        'xdpyinfo_tool': 'present' if fixed_root_client_available() else 'not-established',
        'pidfd_api': 'present' if hasattr(os, 'pidfd_open') and hasattr(signal, 'pidfd_send_signal') else 'not-established',
        'sigchld_handler': 'default' if signal.getsignal(signal.SIGCHLD) == signal.SIG_DFL else 'non-default',
    }
    # These values are all fixed tokens. Never emit paths, UIDs, environment values,
    # usernames, cookies, credentials, exception strings or arbitrary tool output.
    require(all(re.fullmatch('[a-z-]{1,40}', value) for value in values.values()))
    output, temporary = os.environ.get('GITHUB_OUTPUT', ''), os.environ.get('RUNNER_TEMP', '')
    require(temporary.startswith('/') and output.startswith(temporary + '/') and
            os.path.realpath(output) == output)
    info = os.lstat(output)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == uid and info.st_nlink == 1)
    with open(output, 'a', encoding='utf-8') as handle:
        for key, value in values.items():
            handle.write(key + '=' + value + '\n')
    print(json.dumps({'classifications': values, 'ptyAllocated': False,
                      'displayConnected': False, 'applicationExecuted': False,
                      'lifecycleExecuted': False, 'hostEligibility': 'not-established'}, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # One fixed privacy-safe diagnostic; no retry, cleanup or partial success.
        print('::error title=Linux host context::Read-only classification unavailable.')
        raise SystemExit(1)
