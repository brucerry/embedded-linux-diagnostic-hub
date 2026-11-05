// Separate non-shipping build entry. Import has no product/session/listen/timer effects.
import { request, type RequestOptions, type IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import { prepareInstrumentedGateway } from './instrumented-gateway-entry';
import { startInstrumentedGatewayCheck } from '../../scripts/lib/instrumented-gateway-check.mjs';

/** The containing, separately admitted child controller supplies the copied, prelaunch byte binding.
 * This exported function has no CLI, environment reader, process launcher or automatic activation.
 */
export function runPreparedInstrumentedGatewayCheck(prepared: Parameters<typeof startInstrumentedGatewayCheck>[0], token: string) {
    return startInstrumentedGatewayCheck(prepared, token, {
        prepare: prepareInstrumentedGateway,
        request: (options: RequestOptions, callback: (response: IncomingMessage) => void) => request(options, callback),
        setTimer: (callback: () => void, ms: number) => setTimeout(callback, ms),
        clearTimer: (timer: ReturnType<typeof setTimeout>) => { clearTimeout(timer); },
        now: () => performance.now(),
    });
}
