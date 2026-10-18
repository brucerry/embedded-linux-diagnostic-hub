import { fork } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { isolatedGateway } from './memory-resource-gateway-process';
import type { ProductTargetControl, ProductTargetSnapshot } from './memory-product-gateway-target';

/** Real product gateway in its own process plus a private synthetic authenticated SSH target. */
export async function createProductGateway(context: {
    signal?: AbortSignal;
    startup?: import('./native-pilot-startup').NativePilotStartup;
    workDeadlineMs?: number;
    origin: string;
    gcMode: string;
    profile: string;
    emit(stage: string, data: unknown): Promise<void>;
}) {
    assert.ok(context.profile, 'A private qualification profile identity is required.');
    const gateway = await isolatedGateway(context.origin, context.gcMode, context.emit, {
        signal: context.signal,
        ...(context.startup
            ? {
                  forkChild: ((...args: Parameters<typeof import('node:child_process').fork>) =>
                      context.startup!.spawn(
                          'gateway-' + String(args[1]),
                          () => fork(...args),
                          () => {
                              /* OwnedHost's bound AbortSignal forwards its nonce-specific cancel-startup. */
                          },
                      )) as typeof fork,
              }
            : {}),
        workDeadlineMs: context.workDeadlineMs,
        hostFiles: {
            'ssh-fixture-node': fileURLToPath(
                new URL('./memory-product-gateway-host.ts', import.meta.url),
            ),
        },
    });
    let closed = false;
    let closing: Promise<void> | undefined;
    const capabilities = {
        supported: [
            'exec-output',
            'stdout-stderr',
            'slow-output',
            'large-output',
            'stall-release',
            'interactive-shell',
            'explicit-enter',
            'pending-session-open',
            'pause-channel-input',
            'target-connection-loss',
            'actual-product-ownership',
            'actual-process-identity',
        ],
        unsupported: {
            'guaranteed-client-write-block':
                'Pausing target channel input is real; SSH/TCP buffers may still acknowledge a finite write. Primary must observe an actual pending product writer, never infer it from this control.',
            'kernel-loss-or-permission-mutation':
                'No OS permissions, network configuration or external target are mutated.',
            'gateway-process-crash':
                'The gateway host must exit normally for this retained role; client loss is driven by the primary actual product transport, not a forged server receipt.',
        },
    };
    return {
        descriptor: { url: gateway.url, token: gateway.token, options: gateway.options },
        roles: gateway.roles,
        runtimeIdentity: gateway.runtimeIdentity,
        capabilities,
        async control(input: ProductTargetControl) {
            assert.ok(!closed, 'Gateway adapter is closed.');
            const receipt = (await gateway.control(input)) as ProductTargetSnapshot;
            await context.emit('product-target-control', { action: input.action, receipt });
            return receipt;
        },
        sample: gateway.sample,
        sampleProcessHistory: gateway.sampleProcessHistory,
        async snapshotOwners() {
            assert.ok(
                !closed,
                'After close use actual teardown/exit receipts; do not invent zero live snapshots.',
            );
            const values = await gateway.inspect();
            const host = values['gateway-node'],
                target = values['ssh-fixture-node'];
            assert.ok(host.productOwnership, 'Actual gateway product snapshot is missing.');
            assert.ok(target.fixtureOwnership, 'Actual synthetic target snapshot is missing.');
            return {
                product: host.productOwnership,
                target: target.fixtureOwnership as ProductTargetSnapshot,
                services: { gateway: host.resources, target: target.resources },
                caches: {
                    connectionAttempts: host.productOwnership.connectionAttempts,
                    cancelledAttempts: host.productOwnership.cancelledAttemptCache,
                },
            };
        },
        close() {
            return (closing ??= (async () => {
                await gateway.close();
                closed = true;
            })());
        },
        assertExited: gateway.assertExited,
    };
}

export type ProductGateway = Awaited<ReturnType<typeof createProductGateway>>;
