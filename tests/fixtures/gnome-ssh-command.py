"""Private isolated SSH dispatcher. Board responses are software, never hardware operations."""
import os
from pathlib import Path
import sys
import time

command = os.environ.get('SSH_ORIGINAL_COMMAND', '')
prefix = 'export LC_ALL=C; export PATH=/usr/sbin:/usr/bin:/sbin:/bin; '
if command.startswith(prefix):
    probe = command[len(prefix):]
else:
    probe = command
if probe.startswith("\nprintf 'HUB-INVENTORY-1\\n'"):
    sys.stdout.write(Path(__file__).with_name('inventory.wire').read_text())
elif probe == 'timeout -k 2 -s TERM 5 i2cget -y 4 72 0 b':
    time.sleep(3)
    print('0x44')
elif any(token in probe for token in ('i2cget', 'HUB-UART-RESULT', 'HUB-LED-PATTERN')):
    raise SystemExit('Only the fixed software identity adapter is permitted by this fixture.')
else:
    # Real collection/clock and interactive Bash PTY are retained.
    os.execv('/bin/bash', ['/bin/bash', '-c', command] if command else ['/bin/bash', '-i'])
