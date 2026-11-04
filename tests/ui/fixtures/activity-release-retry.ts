import type { Page } from '@playwright/test';

export interface ActivityReleaseRetryState {
    acquireRequests: number;
    grants: string[];
    releaseRequests: string[];
    acknowledged: string[];
    hostEffects: number;
    hostLease: string | null;
    grantPending: boolean;
    retryPending: boolean;
    grant(): void;
    acknowledgeRetry(): void;
}
declare global { interface Window { activityReleaseRetryTest: ActivityReleaseRetryState } }

// Install after navigation. Only this test's synthetic host boundary is substituted.
// No Page/runner callback, private React state, timer, storage, network or port API is invoked here.
export async function installActivityReleaseRetry(page: Page) {
    await page.evaluate(() => {
        if (window.activityReleaseRetryTest) throw Error('Release fixture already installed.');
        const a = '10000000-0000-4000-8000-000000000217';
        const b = '20000000-0000-4000-8000-000000000217';
        let grant: ((id: string) => void) | undefined;
        let retry: (() => void) | undefined;
        const state: ActivityReleaseRetryState = {
            acquireRequests: 0, grants: [], releaseRequests: [], acknowledged: [],
            hostEffects: 0, hostLease: null, grantPending: false, retryPending: false,
            grant() {
                if (!grant || !state.grantPending || state.hostLease)
                    throw Error('No matching synthetic acquisition.');
                const resolve = grant;
                grant = undefined;
                state.grantPending = false;
                const id = state.acquireRequests === 1 ? a : b;
                state.hostLease = id;
                state.grants.push(id);
                resolve(id);
            },
            acknowledgeRetry() {
                if (!retry || !state.retryPending || state.hostLease)
                    throw Error('No matching synthetic retry acknowledgement.');
                const resolve = retry;
                retry = undefined;
                state.retryPending = false;
                resolve();
            },
        };
        window.activityReleaseRetryTest = state;
        const bridge = window.diagnosticHub!;
        bridge.acquireAutomationActivity = () => {
            if (state.acquireRequests >= 2 || state.hostLease || grant)
                throw Error('Unexpected synthetic acquisition or replay.');
            state.acquireRequests++;
            state.grantPending = true;
            return new Promise<string>(resolve => { grant = resolve; });
        };
        bridge.releaseAutomationActivity = async id => {
            if (state.releaseRequests.length >= 3 || !state.grants.includes(id))
                throw Error('Unexpected synthetic release identity/count.');
            state.releaseRequests.push(id);
            if (id === a) {
                const calls = state.releaseRequests.filter(value => value === a).length;
                if (calls === 1) {
                    if (state.hostLease !== a) throw Error('Wrong synthetic host owner.');
                    state.hostLease = null;
                    state.hostEffects++;
                    throw Error('Synthetic host release reply lost after effect.');
                }
                if (calls !== 2 || state.hostLease || retry)
                    throw Error('Duplicate or mismatched synthetic retry.');
                // Mirrors the unchanged native API's stale-ID no-op; delay only its reply.
                state.retryPending = true;
                await new Promise<void>(resolve => { retry = resolve; });
            } else {
                if (id !== b || state.hostLease !== b || state.acknowledged.length !== 1)
                    throw Error('Wrong later synthetic owner.');
                state.hostLease = null;
                state.hostEffects++;
            }
            state.acknowledged.push(id);
        };
    });
}
