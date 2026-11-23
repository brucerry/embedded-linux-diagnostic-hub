"""Exact no-menu 0.6.0 consent grammar. This module neither opens a PTY nor launches anything."""
import re

HOME = '/home/ubuntu/.hub-folder-qualification'
TARGET = HOME+'/installed'
CONFIG = HOME+'/config'
APP = HOME+'/envelope/app'
VERSION = '0.6.0'
PREFIX = '\nDiagnostic Hub Linux setup\nOperation: '
PROFILE = CONFIG+'/DiagnosticHub/profiles/'
UUID = r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
TAIL = '\nType "apply menu" or "apply no-menu" to apply this operation; Enter/cancel leaves everything unchanged: '


def argv(operation):
    if operation not in ('install','uninstall-current'):
        raise ValueError('fixed-folder-operation')
    return [APP+'/diagnostic-hub',APP+'/resources/linux-setup-install.cjs',
            '--install-directory',TARGET,'--version',VERSION,'--operation',operation,
            '--terminal','--no-menu','--no-launch']


def consent(operation, wire, *, installed_profile=None):
    """Return the fixed word and bound profile only for an entire admitted prompt."""
    argv(operation)
    if not isinstance(wire,bytes) or len(wire)>16384:
        raise ValueError('folder-prompt-bound')
    text=wire.decode('utf-8','strict').replace('\r\n','\n')
    prefix=PREFIX+operation+'\nApplication: '+TARGET
    if operation=='install':
        if installed_profile is not None:
            raise ValueError('initial-install-profile')
        pattern=(re.escape(prefix+'\nCandidate version: '+VERSION+'\nInstalled version: none'
                           '\nSettings/reports: '+PROFILE)+f'({UUID})'+
                 re.escape('\nPrevious payloads are retained. No Finalize or removal is performed.'+TAIL))
        matched=re.fullmatch(pattern,text)
        if not matched:
            raise ValueError('exact-install-prompt')
        profile=PROFILE+matched[1]
    else:
        if not isinstance(installed_profile,str) or not re.fullmatch(re.escape(PROFILE)+UUID,installed_profile):
            raise ValueError('installed-profile-readback')
        exact=(prefix+'\nInstalled version: '+VERSION+'\nSettings/reports retained: '+installed_profile+
               '\nOnly this current no-menu payload is removed. '
               'Original transaction records are retained, including any completed initial Finalize journal. '
               'Prior recovery payloads are not removed.'+TAIL)
        if text!=exact:
            raise ValueError('exact-uninstall-prompt')
        profile=installed_profile
    return b'apply no-menu\n',profile
