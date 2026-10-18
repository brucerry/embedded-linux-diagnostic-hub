import assert from 'node:assert/strict';
import path from 'node:path';
import { requirePilotRuntimeReady } from '../../scripts/lib/hosted-pilot-contract.mjs';
import type { ReviewedNativeCoverage } from './memory-product-native-contract';
import type { QualificationDriver } from './memory-resource-core';
/** Inert finite adapter, NOT a CLI. Its default gate blocks native startup until write containment/overshoot/startup custody are reviewed. */
export async function finiteNativeReadiness(input: {
    privateRoot: string;
    pilot?: Record<string, any>;
    startup?: import('./native-pilot-startup').NativePilotStartup;
    nativeCoverage: ReviewedNativeCoverage;
    signal: AbortSignal;
    workDeadlineMs: number;
    emit(stage: string, value: unknown): Promise<void>;
    holdUnknown(reason: unknown): void;
    gate?: () => void;
    createDriver?: (options: any) => Promise<QualificationDriver>;
}) {
    const gate = input.gate ?? requirePilotRuntimeReady;
    gate();
    input.signal.throwIfAborted();
    assert(path.isAbsolute(input.privateRoot));
    const factory =
        input.createDriver ??
        (await import('./memory-product-aggregate-native')).createNativeAggregateDriver;
    let driver: QualificationDriver | undefined,
        joined = false;
    try {
        // A rejected factory may already own build/Electron/IPC children: no no-child inference.
        driver = await factory({
            lane: 'desktop',
            pilot: input.pilot,
            startup: input.startup,
            gcMode: 'normal',
            nativeCoverage: input.nativeCoverage,
            profile: path.join(input.privateRoot, 'native-profile'),
            viewer: false,
            component: false,
            signal: input.signal,
            workDeadlineMs: input.workDeadlineMs,
            emit: input.emit,
        });
        const cancel = () => {
            void driver!.teardown().catch(input.holdUnknown);
        };
        input.signal.addEventListener('abort', cancel, { once: true });
        if (input.signal.aborted) cancel();
        gate();
        input.signal.throwIfAborted();
        const result = await driver.cycle({
            phase: 'measured',
            ordinal: 1,
            payloadBytes: 65536,
            catalogMode: 'growing',
        });
        for (const required of [
            'native-renderer-generation-reset-reopen',
            'export-cancel',
            'export-failure',
            'clear-reopen',
        ])
            assert(
                result.coverage.includes(required),
                'Missing actual native pilot boundary: ' + required,
            );
        await input.emit('finite-native-readiness', {
            kind: 'prerequisite-pilot-only',
            cycles: 1,
            normalGC: true,
            thirtyMinuteCoverage: false,
            min100CycleCoverage: false,
            result,
        });
        await driver.teardown();
        await driver.assertDescendantsExited();
        joined = true;
        input.signal.removeEventListener('abort', cancel);
        return {
            nativeCases: result.coverage,
            cycles: 1,
            normalGC: true,
            actualDescendantsJoined: true,
            fullCollection: false,
        };
    } catch (error) {
        if (driver && !joined)
            try {
                await driver.teardown();
                await driver.assertDescendantsExited();
                joined = true;
            } catch (cleanup) {
                input.holdUnknown(cleanup);
            }
        if ((!driver && !input.startup) || (driver && !joined)) input.holdUnknown(error);
        throw error;
    }
}
