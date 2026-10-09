import type { Client } from 'ssh2';
import { validateTest } from '../../shared/testing/profile';
import { validateResource } from '../../shared/testing/inventory';
import { CASE_BYTES, type Evidence, type PreparedCase } from '../../shared/testing/types';
import { executeBounded, executionEvidence, shellQuote } from './executor';

export const UART_SCRIPT = String.raw`
import os,sys,termios,fcntl,select,time,json,signal,errno
path,baud,payload,seconds=sys.argv[1],int(sys.argv[2]),bytes.fromhex(sys.argv[3]),float(sys.argv[4])
fd=None; original=None; cleanup=False; exclusive=False; received=b''; result='error'; reason=''
def interrupted(signum,frame): raise KeyboardInterrupt()
signal.signal(signal.SIGTERM,interrupted)
try:
    speed=getattr(termios,'B'+str(baud),None)
    if speed is None: raise ValueError('Unsupported device baud rate')
    fd=os.open(path,os.O_RDWR|os.O_NOCTTY|os.O_NONBLOCK)
    fcntl.ioctl(fd,termios.TIOCEXCL)
    exclusive=True
    original=termios.tcgetattr(fd)
    attrs=termios.tcgetattr(fd)
    attrs[0]=0; attrs[1]=0; attrs[2]=termios.CS8|termios.CREAD|termios.CLOCAL; attrs[3]=0
    attrs[4]=speed; attrs[5]=speed; attrs[6][termios.VMIN]=0; attrs[6][termios.VTIME]=0
    termios.tcsetattr(fd,termios.TCSANOW,attrs)
    termios.tcflush(fd,termios.TCIOFLUSH)
    deadline=time.monotonic()+seconds; sent=0
    while time.monotonic()<deadline and (sent<len(payload) or len(received)<len(payload)):
        ready,writable,_=select.select([fd],[fd] if sent<len(payload) else [],[],min(.05,max(0,deadline-time.monotonic())))
        if writable:
            try: sent+=os.write(fd,payload[sent:])
            except BlockingIOError: pass
        if ready:
            try: received+=os.read(fd,min(8192,len(payload)+1-len(received)))
            except BlockingIOError: pass
        if len(received)>len(payload): break
    result='ok' if received==payload and sent==len(payload) else 'mismatch'
    reason='Exact bytes returned.' if result=='ok' else 'Loopback bytes differ or did not arrive within the timeout.'
except KeyboardInterrupt: result='interrupted'; reason='UART test interrupted.'
except (PermissionError,BlockingIOError) as error: result='blocked'; reason=str(error)
except OSError as error:
    result='blocked' if error.errno in (errno.EBUSY,errno.EACCES,errno.EPERM,errno.ENOENT) else 'error'
    reason=str(error)
except Exception as error: reason=str(error)
finally:
    if fd is not None:
        try:
            if original is not None:
                termios.tcsetattr(fd,termios.TCSANOW,original)
                cleanup=termios.tcgetattr(fd)==original
            else: cleanup=True
        except Exception as error: reason+='; restoration: '+str(error)
        try:
            if exclusive: fcntl.ioctl(fd,termios.TIOCNXCL)
        except Exception: pass
        os.close(fd)
    else: cleanup=True
    print('HUB-UART-RESULT '+json.dumps({'execution':result,'reason':reason,'measured':received.hex(),'cleanup':cleanup}))
`;

export function adapterCommand(input: PreparedCase): { command: string; timeoutMs: number } {
    const test = validateTest(input.test),
        resource = validateResource(input.resource);
    if (
        resource.domain !== test.adapter.split('.')[0] ||
        Object.values(test.parameters).some((v) => v === null)
    )
        throw Error('Unresolved or incomplete adapter request.');
    const p = test.parameters;
    if (test.adapter === 'led.pattern') {
        const duration = Math.ceil((Number(p.cycles) * Number(p.intervalMs) * 2) / 1000) + 5;
        const script = String.raw`
led=${shellQuote(resource.path)}
noop() { printf 'HUB-LED-CLEANUP unchanged\n'; exit 126; }
original=$(cat "$led/brightness") || noop
trigger=$(sed -n 's/.*\[\([^]]*\)\].*/\1/p' "$led/trigger")
[ -n "$trigger" ] || noop
case "$original" in ''|*[!0-9]*) noop;; esac
restore() {
    trap - EXIT HUP INT TERM
    if printf '%s' "$original" > "$led/brightness" && printf '%s' "$trigger" > "$led/trigger"; then
        current=$(cat "$led/brightness")
        active=$(sed -n 's/.*\[\([^]]*\)\].*/\1/p' "$led/trigger")
        if [ "$active" = "$trigger" ] && { [ "$trigger" != none ] || [ "$current" = "$original" ]; }; then printf 'HUB-LED-CLEANUP verified\n'; else printf 'HUB-LED-CLEANUP unverified\n'; fi
    else printf 'HUB-LED-CLEANUP unverified\n'; fi
}
trap restore EXIT
trap 'exit 130' HUP INT TERM
printf none > "$led/trigger" || exit 126
i=0
while [ "$i" -lt ${Number(p.cycles)} ]; do
    printf '%s' ${Number(p.level)} > "$led/brightness" || exit 1
    sleep ${(Number(p.intervalMs) / 1000).toFixed(3)} || exit 1
    printf 0 > "$led/brightness" || exit 1
    sleep ${(Number(p.intervalMs) / 1000).toFixed(3)} || exit 1
    i=$((i+1))
done
printf 'HUB-LED-PATTERN completed\n'
`;
        return {
            command: `timeout -k 2 -s TERM ${duration} sh -c ${shellQuote(script)}`,
            timeoutMs: duration * 1000,
        };
    }
    if (test.adapter === 'uart.loopback') {
        const payload = Buffer.from(String(p.payload)).toString('hex');
        return {
            command: `timeout -k 2 -s TERM 10 python3 -c ${shellQuote(UART_SCRIPT)} ${shellQuote(resource.path)} ${Number(p.baud)} ${shellQuote(payload)} ${(Number(p.timeoutMs) / 1000).toFixed(3)}`,
            timeoutMs: 10000,
        };
    }
    const bus = Number(resource.metadata.bus);
    if (
        !Number.isSafeInteger(bus) ||
        bus < 0 ||
        bus > 65535 ||
        resource.address === null ||
        resource.address < 3 ||
        resource.address > 119
    )
        throw Error('Invalid resolved I2C bus/address.');
    return {
        command: `timeout -k 2 -s TERM 5 i2cget -y ${bus} ${resource.address} ${Number(p.register)} b`,
        timeoutMs: 5000,
    };
}
export async function executeAdapter(
    client: Client,
    input: PreparedCase,
    signal: AbortSignal,
): Promise<Evidence> {
    const { command, timeoutMs } = adapterCommand(input);
    const output = await executeBounded(client, command, signal, timeoutMs, CASE_BYTES);
    const evidence = executionEvidence(output);
    if (input.test.adapter === 'led.pattern') {
        const unchanged =
            /(?:^|\n)HUB-LED-CLEANUP unchanged(?:\n|$)/.test(output.stdout) && !output.truncated;
        evidence.cleanup =
            /(?:^|\n)HUB-LED-CLEANUP verified(?:\n|$)/.test(output.stdout) && !output.truncated
                ? 'verified'
                : unchanged
                  ? 'not-needed'
                  : 'unverified';
        evidence.cleanupDetail =
            evidence.cleanup === 'verified'
                ? 'Original brightness and trigger restored; trigger-owned brightness resumes under its driver.'
                : unchanged
                  ? 'State capture failed before any hardware write.'
                  : 'Original LED state restoration could not be verified.';
        if (unchanged && !output.interrupted) {
            evidence.execution = 'blocked';
            evidence.reason = 'Original LED state could not be captured; no writes attempted.';
        }
        if (output.exitCode === 0 && !output.stdout.includes('HUB-LED-PATTERN completed'))
            evidence.execution = 'error';
        evidence.measured = output.stdout.includes('HUB-LED-PATTERN completed')
            ? 'pattern-executed'
            : null;
        evidence.reason =
            evidence.execution === 'ok'
                ? 'Pattern completed; waiting for physical observation.'
                : evidence.reason;
    } else if (input.test.adapter === 'uart.loopback') {
        const marker = output.stdout.match(/(?:^|\n)HUB-UART-RESULT (.+)(?:\n|$)/);
        if (marker && !output.truncated) {
            try {
                const result = JSON.parse(marker[1]);
                if (
                    !['ok', 'mismatch', 'blocked', 'error', 'interrupted'].includes(
                        result.execution,
                    ) ||
                    typeof result.measured !== 'string' ||
                    !/^[0-9a-f]*$/.test(result.measured) ||
                    result.measured.length > 32768 ||
                    typeof result.reason !== 'string' ||
                    typeof result.cleanup !== 'boolean'
                )
                    throw Error('Malformed UART result.');
                evidence.execution = output.interrupted ? 'interrupted' : result.execution;
                evidence.reason = result.reason.slice(0, 2048);
                evidence.measured = result.measured;
                evidence.cleanup = result.cleanup ? 'verified' : 'unverified';
                evidence.cleanupDetail = result.cleanup
                    ? 'Captured serial settings restored and test handle closed.'
                    : 'Serial restoration was not verified.';
            } catch {
                evidence.reason = 'Malformed UART evidence.';
                evidence.execution = 'error';
            }
        }
    } else {
        evidence.cleanup = 'not-needed';
        evidence.cleanupDetail = 'Approved read only; no driver or settings changed.';
        const value = output.stdout.trim();
        if (output.exitCode === 0 && /^0x[0-9a-fA-F]{2}$/.test(value) && !output.truncated)
            evidence.measured = parseInt(value, 16);
        else if (
            /busy|permission denied|could not open|resource unavailable/i.test(output.stderr)
        ) {
            evidence.execution = 'blocked';
            evidence.reason =
                'Approved I2C access is unavailable or owned by a driver; no force access attempted.';
        } else if (output.exitCode === 0) {
            evidence.execution = 'error';
            evidence.reason = 'Malformed I2C identity response.';
        }
    }
    return evidence;
}
