import type { ServerChannel } from 'ssh2';
import { simulatedInventory } from '../../shared/testing/simulation';
import type { Inventory } from '../../shared/testing/types';

export function discoveryWire(inventory: Inventory = simulatedInventory()): string {
    const hex = (value: unknown) => Buffer.from(String(value ?? '')).toString('hex');
    const lines = ['HUB-INVENTORY-1'];
    for (const key of ['model', 'kernel', 'firmware', 'serial', 'bootId'] as const)
        lines.push(`D\t${key}\t${hex(inventory.device[key])}`);
    for (const [key, value] of Object.entries(inventory.capabilities))
        lines.push(`C\t${key}\t${value ? 1 : 0}`);
    for (const node of inventory.nodes)
        for (const [key, value] of Object.entries(node.properties))
            lines.push(`N\t${hex(node.path)}\t${hex(key)}\t${value}`);
    for (const issue of inventory.issues) lines.push(`E\t${hex(issue)}`);
    for (const r of inventory.resources)
        lines.push(
            'R\t' +
                [
                    r.domain,
                    r.name,
                    r.path,
                    r.ofNode,
                    r.controller,
                    r.identity,
                    r.address,
                    r.console ? 1 : 0,
                    r.writable ? 1 : 0,
                    r.metadata.maxBrightness,
                    r.metadata.bus,
                    r.metadata.busy,
                    r.metadata.trigger,
                ]
                    .map(hex)
                    .join('\t'),
        );
    return lines.concat('HUB-INVENTORY-END', '').join('\n');
}
export function testingFixture() {
    const state = {
        inventory: simulatedInventory(),
        calls: [] as string[],
        delayMs: 0,
        uartMismatch: false,
        i2cValue: '0x44',
        ledCleanup: true,
        lost: false,
        channels: new Set<ServerChannel>(),
    };
    function exec(command: string, channel: ServerChannel): boolean {
        const discovery = command.includes("printf 'HUB-INVENTORY-1");
        const led = command.includes('HUB-LED-PATTERN completed');
        const uart = command.includes('HUB-UART-RESULT ');
        const i2c = command.includes('i2cget -y');
        if (!discovery && !led && !uart && !i2c) return false;
        state.calls.push(discovery ? 'discovery' : led ? 'led' : uart ? 'uart' : 'i2c');
        state.channels.add(channel);
        channel.resume();
        channel.on('end', () => channel.close());
        let ended = false;
        const respond = (interrupted = false) => {
            if (ended || channel.destroyed) return;
            ended = true;
            if (discovery) channel.write(discoveryWire(state.inventory));
            else if (led)
                channel.write(
                    `${interrupted ? '' : 'HUB-LED-PATTERN completed\n'}HUB-LED-CLEANUP ${state.ledCleanup ? 'verified' : 'unverified'}\n`,
                );
            else if (uart) {
                const payload = command.match(/ ([0-9]+) '([0-9a-f]+)' ([0-9.]+)$/)?.[2] || '';
                channel.write(
                    'HUB-UART-RESULT ' +
                        JSON.stringify({
                            execution: interrupted
                                ? 'interrupted'
                                : state.uartMismatch
                                  ? 'mismatch'
                                  : 'ok',
                            reason: 'Software serial fixture',
                            measured: state.uartMismatch ? '00' : payload,
                            cleanup: true,
                        }) +
                        '\n',
                );
            } else channel.write(state.i2cValue + '\n');
            channel.exit(interrupted ? 130 : 0);
            channel.end();
            channel.close();
        };
        channel.on(
            'signal',
            (
                _accept: (() => void) | undefined,
                _reject: (() => void) | undefined,
                info: { name: string },
            ) => {
                if (info.name === 'TERM') respond(true);
            },
        );
        channel.on('close', () => state.channels.delete(channel));
        if (!state.lost) setTimeout(respond, discovery ? 0 : state.delayMs);
        return true;
    }
    return { state, exec };
}
