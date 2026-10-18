/** Owned private target entry. Production main/preload/gateway APIs are untouched. */
import { runGatewayHost } from './memory-resource-gateway-host';
import { createProductTarget } from './memory-product-gateway-target';
void runGatewayHost({ createTarget: createProductTarget }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
    if (process.connected) process.disconnect!();
});
