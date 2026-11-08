import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Test-only bindings to the reviewed formatted production bytes. This is not runtime evidence.
export const callbackSourceCommit = 'ef3b0b82f77152ad3bbadfa5b7c5fabffde6d008';
export const callbackSourcePins: Readonly<Record<string, string>> = Object.freeze({
    'src/features/serial/SerialPage.tsx':
        '827a50016dee4ddba1bb1e8b9c61363a0fba1b37eba6ff511eb9d31a0309ee60',
    'src/features/automation/AutomationPage.tsx':
        '53c4e9f4d6348698e09ffad6a151aa87a1408d2c58207a6833b634223cae36e2',
    'src/hooks/useDeviceClock.ts':
        '012a51e6ea44c36c771c0e4c7f4d78da21435c56a6902f98b2b9723ba9f67e30',
    'src/features/automation/capture/use-console-results.ts':
        '2a1c8b658a50cbc65bb9498f61e8cfd82097018e8f7bed31a74d69432a58a851',
    'src/features/automation/capture/StoredSerialResults.tsx':
        '44d9c42ee7c00905e44e65234c44c554d79b8f0e11222d1e78b1589a7e5cfc5e',
});
export function assertCallbackSource(file: string, source: string): void {
    assert.ok(Object.hasOwn(callbackSourcePins, file), 'Unsupported callback source binding.');
    assert.equal(
        createHash('sha256').update(source).digest('hex'),
        callbackSourcePins[file],
        'Callback source preimage changed; review before rebinding.',
    );
}
