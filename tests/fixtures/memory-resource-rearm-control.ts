import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sshQualificationProfile } from './memory-resource-ssh-profile';
import { NativeCaptureStore } from '../../electron/capture-store';
import { CaptureStorageError, type CaptureRepository } from '../../shared/capture-store';
import { sshCycle } from './memory-resource-ssh';
import { Owners } from './memory-resource-core';
import { trackedRepository } from './memory-resource-cycle';

/** Controlled permission-error attribution; never changes an OS permission or retained fixture. */
async function main() {
    const outputArgument = process.argv.find((argument) => argument.startsWith('--out='));
    assert.ok(outputArgument, 'Provide --out=<private evidence directory>.');
    const output = path.resolve(outputArgument.slice(6));
    await fs.mkdir(output, { recursive: true });
    const profile = await fs.mkdtemp(path.join(output, 'rearm-control-'));
    const sshRuntime = await sshQualificationProfile();
    const owners = new Owners();
    const native = await NativeCaptureStore.open(profile, { profileOwned: true });
    const tracked = trackedRepository(native, owners);
    let command = '',
        appends = 0,
        injected = false,
        failure: unknown;
    const store = new Proxy(tracked, {
        get(target, key) {
            if (key === 'begin')
                return async (...args: Parameters<CaptureRepository['begin']>) => {
                    command = args[0].command;
                    appends = 0;
                    return target.begin(...args);
                };
            if (key === 'append')
                return async (...args: Parameters<CaptureRepository['append']>) => {
                    if (command === 'rearmed' && ++appends === 3) {
                        injected = true;
                        throw new CaptureStorageError(
                            'permission',
                            'Synthetic EPERM metadata rename denial.',
                        );
                    }
                    return target.append(...args);
                };
            return Reflect.get(target, key);
        },
    });
    try {
        await sshCycle(store, 1024 ** 2, owners);
    } catch (error) {
        failure = error;
    } finally {
        await native.close();
    }
    owners.empty('permission control teardown');
    assert.equal(injected, true);
    assert.ok(failure, 'A storage failure must not become a successful rearm.');
    assert.match(String(failure), /"phase":"rearm"/);
    assert.match(String(failure), /"completion":"storage-error"/);
    assert.match(String(failure), /"code":"permission"/);
    assert.match(String(failure), /"lastState":"paused"/);
    assert.match(String(failure), /Capture incomplete \(permission\)/);
    const reopened = await NativeCaptureStore.open(profile, { profileOwned: true });
    let capture;
    try {
        capture = (await reopened.page()).records.find(
            (record) => record.header.command === 'rearmed',
        );
        assert.ok(capture);
        assert.equal(capture.state, 'incomplete');
        assert.equal(capture.failure?.code, 'permission');
        assert.ok(capture.committedBytes > 0 && capture.observedBytes! > capture.committedBytes);
    } finally {
        await reopened.close();
    }
    const receipt = {
        status: 'passed-expected-permission-detection',
        injected: true,
        failure: String(failure).slice(0, 4096),
        capture,
        owners: owners.snapshot(),
        sshRuntime,
        profile,
        scope: 'one synthetic production SSH cycle; no OS fault reproduction, timing relaxation, sampler-causation or final memory qualification',
    };
    await fs.writeFile(path.join(profile, 'receipt.json'), JSON.stringify(receipt, null, 2), {
        flag: 'wx',
    });
    console.log(JSON.stringify(receipt));
}
void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
