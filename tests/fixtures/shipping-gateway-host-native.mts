// Definition-only native entry. A real external custodian must import and invoke this export.
// No CLI bootstrap, lifetime default, package load or native activation occurs at import.
import assert from 'node:assert/strict';
import { prepareNativeShippingGatewayCaller } from './shipping-gateway-caller-native.mts';
import { prepareShippingGatewayHost } from './shipping-gateway-host.ts';

export function prepareNativeShippingGatewayHost(input: any, lifetime: any) {
    let inherited: typeof process.stdout | undefined;
    // Acquire Node's inherited-stream wrapper only after the existing output owner is retained.
    const stdout = {
        on(event: string, listener: (...args: any[]) => void): any {
            inherited ??= process.stdout;
            const installed = inherited.on(event, listener);
            return installed === inherited ? stdout : installed;
        },
        write(bytes: Buffer, callback: (error?: Error | null) => void) {
            assert.ok(inherited);
            return inherited.write(bytes, callback);
        },
    };
    return prepareShippingGatewayHost(input, {
        lifetime,
        stdout,
        setFailure() {
            process.exitCode = 1;
        },
        assertRuntime(selection: any) {
            assert.equal(process.platform, 'linux');
            assert.match(process.version, /^v24\./);
            assert.equal(process.execPath, selection.node.path);
            assert.deepEqual(process.execArgv, []);
            assert.equal(process.env.NODE_OPTIONS, undefined);
            assert.equal(process.env.NODE_PATH, undefined);
            assert.equal(process.getuid?.(), selection.uid);
        },
        prepareCaller: prepareNativeShippingGatewayCaller,
    });
}
