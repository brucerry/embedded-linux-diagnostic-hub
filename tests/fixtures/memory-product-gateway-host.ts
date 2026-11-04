/** Owned private target entry. Production main/preload/gateway APIs are untouched. */
import { runGatewayHost } from './memory-resource-gateway-host';
import { createProductTarget } from './memory-product-gateway-target';
import { fileURLToPath } from 'node:url';
import { createProductHostObservation } from './memory-product-host-source';
const observation = createProductHostObservation(fileURLToPath(new URL('../..', import.meta.url)), 'gateway');
void runGatewayHost({ createTarget: createProductTarget, ...observation }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
    if (process.connected) process.disconnect!();
});
