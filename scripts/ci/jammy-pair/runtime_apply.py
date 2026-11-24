"""Run the exact previously admitted stock APT route with a bounded private status pipe."""
from dataclasses import dataclass
import os
from pathlib import Path
import subprocess
from time import monotonic

from runtime_apply_observer import drain, unobserved, Status

APT='/usr/bin/apt-get'
FLAGS=('--no-download','--no-remove','--no-install-recommends')
PIPE_KEY='APT::Status-deb822-Fd'
SCOPE_SECS=240
EXIT_STATES=('zero','nonzero','signal','unobserved')
STREAM_STATES=('valid','empty','invalid-status','status-cap','output-cap','capture-timeout',
               'capture-io','capture-cancel','launch-refused')
PROGRESS_STATES=('no-batch-announcement','batch-announced','child-reported','unobserved')


@dataclass(frozen=True)
class Result:
    exit: str
    observation: Status
    child_closed: bool

    def fields(self):
        state=self.observation
        flags=('unobserved','unobserved')
        if state.stream in ('valid','empty'):
            flags=('seen' if state.package_error else 'not-seen',
                   'seen' if state.conffile_prompt else 'not-seen')
        return (self.exit,state.stream,state.progress,*flags,'closed' if self.child_closed else 'uncertain')


def retire_child(child, deadline):
    if child.poll() is not None:
        return True
    try:
        child.kill()
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=max(0,deadline-monotonic()))
    except subprocess.TimeoutExpired:
        return False
    return child.poll() is not None


def apply(archives, env, deadline, check_config):
    permitted = (
        [f'/mnt/hub-apt-witness/p{i:03}.deb' for i in range(54)],
        [f'/mnt/hub-apt-runtime/p{i:03}.deb' for i in range(51)],
    )
    if list(archives) not in permitted:
        raise ValueError('provision-absolute-archive-argv')
    end=min(monotonic()+SCOPE_SECS,deadline)
    capture_until=end-4
    read_fd,write_fd=os.pipe2(os.O_CLOEXEC)
    child=None
    try:
        if min(read_fd,write_fd)<3 or monotonic()>=capture_until:
            return Result('unobserved',unobserved('capture-timeout'),True)
        option=f'{PIPE_KEY}={write_fd}'
        check_config(option,capture_until)
        if monotonic()>=capture_until:
            return Result('unobserved',unobserved('capture-timeout'),True)
        try:
            child=subprocess.Popen([APT,*FLAGS,'--assume-yes','-o',option,'install',*archives],
                stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,
                close_fds=True,pass_fds=(write_fd,),start_new_session=True)
        except OSError:
            return Result('unobserved',unobserved('launch-refused'),True)
        os.close(write_fd)
        write_fd=None
        try:
            observed=drain(child.stdout.fileno(),child.stderr.fileno(),read_fd,capture_until)
            if observed.stream in ('capture-timeout','status-cap','output-cap'):
                return Result('unobserved',observed,retire_child(child,end))
            code=child.wait(timeout=max(0,capture_until-monotonic()))
            verdict='zero' if code==0 else 'signal' if code<0 else 'nonzero'
            return Result(verdict,observed,True)
        except (OSError,subprocess.TimeoutExpired,InterruptedError,KeyboardInterrupt) as error:
            category=('capture-timeout' if isinstance(error,subprocess.TimeoutExpired) else
                      'capture-cancel' if isinstance(error,(InterruptedError,KeyboardInterrupt)) else 'capture-io')
            return Result('unobserved',unobserved(category),retire_child(child,end))
    finally:
        if write_fd is not None:
            os.close(write_fd)
        os.close(read_fd)
        if child is not None:
            child.stdout.close()
            child.stderr.close()
