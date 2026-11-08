// Separate non-shipping build entry. No top-level connect, factory call, listener or launch.
import { Session, url } from 'node:inspector';
import { createGateway } from '../../gateway/server';
import { createInstrumentedGatewayBootstrap } from '../../scripts/lib/instrumented-gateway-observer.mjs';

export function prepareInstrumentedGateway(
    selection: Record<string, unknown>,
    scripts: Map<string, Buffer>,
) {
    return createInstrumentedGatewayBootstrap(
        selection,
        scripts,
        () => {
            // Own only an in-process session; never open or inherit a TCP inspector endpoint.
            if (url() !== undefined)
                throw Error('An externally listening inspector is unsupported.');
            return new Session();
        },
        createGateway,
    );
}
