import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createLinuxNativeDriver } from '../electron/linux-native-driver.ts';

test('native driver has no implicit loader or native operations fallback', () => {
    assert.throws(
        () => createLinuxNativeDriver({} as never, {} as never),
        /^Error: ERR_DH_LINUX_NATIVE_LOADER_UNADMITTED$/,
    );
});
test('native driver remains unregistered and Linux packaged entry permits review only', async () => {
    for (const file of [
        'electron/setup-worker.ts',
        'electron/setup-transaction.ts',
        'scripts/linux-setup-review.cts',
    ]) {
        const source = await readFile(file, 'utf8');
        assert.ok(!source.includes('linux-native-driver'));
    }
    const entry = await readFile('scripts/linux-setup-review.cts', 'utf8');
    assert.ok(
        entry.includes(
            "if (choices.operation !== 'review') throw Error('LINUX_REVIEW_HELPER_REFUSED')",
        ),
    );
    const driver = await readFile('electron/linux-native-driver.ts', 'utf8');
    assert.doesNotMatch(driver, /\b(?:require|dlopen|spawn|execFile|rename|unlink|chmod)\s*\(/);
    const backend = await readFile('electron/linux-native-backend.ts', 'utf8');
    assert.ok(backend.includes('moveNoReplace: null,'));
});
