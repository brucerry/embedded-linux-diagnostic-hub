import { consoleRpcRequest, type ConsoleOwner } from '../../../shared/console-rpc';
import { consoleArchiveRequest } from '../../../shared/console-archive-rpc';

export const EVIDENCE_FAILURE = 'Synthetic retained console evidence could not be acknowledged.';
export const RETRY_OUTCOME = 'Console stopped with incomplete or unacknowledged evidence: ' + EVIDENCE_FAILURE;
export const CLEANUP_LEASE = 'cleanup-retry-lease-0001';
export const CLEANUP_CONNECTION = 'cleanup-retry-connection-001';

/** Bounded fake native-service boundary. No timer, transport, storage or DOM operations. */
export function createCleanupRetryBoundary() {
    let owner: ConsoleOwner | undefined;
    let readClosed!: () => void, allowRetry!: () => void;
    let retryAllowed = false, leaseHeld = false;
    const closed = new Promise<void>(resolve => { readClosed = resolve; });
    const retry = new Promise<void>(resolve => { allowRetry = resolve; });
    const state = { reads: 0, opens: 0, commands: [] as string[], finishes: 0,
        retryPending: false, retryAcknowledged: false, ownerReleased: 0,
        activityAcquires: 0, activityReleases: 0, catalogLists: 0, calls: 0 };
    const ensure = (valid: unknown, message: string) => {
        if (!valid) throw Error('Cleanup retry fixture: ' + message);
    };
    const closedState = () => ({ protocol: 1, id: owner!.id, revision: 2,
        phase: 'closed', error: EVIDENCE_FAILURE, snapshot: null, ownerHeld: false,
        cleanup: { storageAdapterClosed: true, journalClosure: 'acknowledged' } });
    return {
        snapshot: () => ({ ...state, commands: [...state.commands], leaseHeld }),
        acknowledgeRetry() {
            if (!retryAllowed) { retryAllowed = true; allowRetry(); }
        },
        acquireActivity: async () => {
            ensure(++state.activityAcquires === 1 && !leaseHeld, 'unexpected activity acquisition');
            leaseHeld = true;
            return CLEANUP_LEASE;
        },
        releaseActivity: async (id: string) => {
            ensure(id === CLEANUP_LEASE && leaseHeld && state.ownerReleased === 1,
                'activity released before matching console retirement');
            ensure(++state.activityReleases === 1, 'duplicate activity release');
            leaseHeld = false;
        },
        archive: async (input: unknown) => {
            const request = consoleArchiveRequest(input);
            ensure(request.op === 'list' && ++state.catalogLists <= 16,
                'only bounded empty catalog reads are admitted');
            return { ok: true, value: { captures: [], next: null, mode: 'scan' } };
        },
        async rpc(input: unknown) {
            ensure(++state.calls <= 16, 'RPC call bound exceeded');
            const request = consoleRpcRequest(input);
            if (request.action === 'capabilities') return {
                protocol: 1, persistentConsole: 1, independentStream: 1,
                epoch: 'c'.repeat(32), receiveTimeSource: 'local-client',
                journal: 'native-v2', heartbeat: null,
            };
            if (request.action === 'open') {
                ensure(++state.opens === 1 && request.connection === CLEANUP_CONNECTION,
                    'unexpected console open or replay');
                owner = { id: request.id, connection: request.connection, capability: 'd'.repeat(64) };
                return { protocol: 1, ...owner };
            }
            ensure(owner && request.id === owner.id && request.connection === owner.connection &&
                request.capability === owner.capability, 'stale owner');
            if (request.action === 'read') {
                ensure(++state.reads <= 2, 'unexpected read');
                if (state.reads === 1) return { protocol: 1, type: 'state', id: owner!.id,
                    revision: 1, phase: 'ready', error: null, snapshot: null, ownerHeld: true,
                    cleanup: { storageAdapterClosed: false, journalClosure: 'pending' } };
                await closed;
                return { type: 'state', ...closedState() };
            }
            if (request.action === 'step') {
                ensure(state.commands.length === 0 && request.sequence === 0 &&
                    request.segment.input.intent === 'script' &&
                    request.segment.input.command === 'FAIL_ONCE', 'unexpected command or replay');
                state.commands.push(request.segment.input.command);
                throw Error(EVIDENCE_FAILURE);
            }
            if (request.action === 'finish') {
                ensure(++state.finishes <= 2, 'unexpected cleanup retry');
                if (state.finishes === 1) throw Error('Synthetic console close receipt unavailable.');
                state.retryPending = true;
                await retry;
                state.retryPending = false;
                state.retryAcknowledged = true;
                readClosed();
                return closedState();
            }
            if (request.action === 'release') {
                ensure(state.retryAcknowledged && ++state.ownerReleased === 1,
                    'console owner released before acknowledgement or twice');
                return { ok: true };
            }
            throw Error('Cleanup retry fixture: unadmitted RPC operation');
        },
    };
}

declare global {
    interface Window {
        cleanupRetryTest: ReturnType<typeof createCleanupRetryBoundary>;
    }
}
