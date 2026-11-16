import { fileURLToPath } from 'node:url';

/** Import-only boundary. The selected module's main guard stays inactive here; no producer,
 * helper, adapter or Gateway is invoked. Failures yield only a fixed nonzero exit status.
 * Importability is not executable provenance, worker entry or runtime qualification.
 */
export async function checkGatewayHealthEntry(load = (url) => import(url)) {
    try {
        const entry = await load(new URL('./observe-gateway-health-job.mjs', import.meta.url).href);
        return typeof entry?.observeGatewayHealthJob === 'function' ? 0 : 1;
    } catch {
        return 1;
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    process.exitCode = process.argv.length === 2 ? await checkGatewayHealthEntry() : 1;
}
