import assert from 'node:assert/strict';
import { sourceDigest } from './committed-source-bridge.mjs';

export const RAW_CLI_REFERENCE = Object.freeze({ sourceCommit: '760dba0c7ab9f44b8eb7e00a4b53923272ea488a',
    sourceTree: '596e7f87fd8ef697e2f5b1509b342c0edddce7ec', runId: '41990160342', jobId: '127120220376', attempt: '1',
    receiptSHA256: '93c09e75f5f719a3ede713eadf6014d75a892979fe8e171b8e822790f50ecd9c',
    productionInventorySHA256: '14c3f8cb832fc751c0676ccdb16cecc747e2c3eac0d0ef31d0182b462f9d9325', productionFiles: 213 });
export const INSTRUMENTED_ACTIVATION = 'tests/fixtures/instrumented-gateway-activate.cjs';
export const INSTRUMENTED_ENTRY = 'tests/fixtures/instrumented-gateway-check-entry.ts';
const directories = ['src/', 'shared/', 'electron/', 'backend/', 'gateway/', 'public/'];
const files = ['package.json', 'package-lock.json', 'vite.config.mts', 'index.html', 'tsconfig.json', 'LICENSE', '.env.gateway.example', 'docs/gateway.md'];
function productionInventory(bridge) {
    return bridge.inventory.filter((r) => files.includes(r.path) || directories.some((p) => r.path.startsWith(p)))
        .map(({ path, mode, blob, bytes, sha256 }) => ({ path, mode, blob, bytes, sha256 }));
}
export function assertInstrumentedProductionBridge(bridge) {
    const production = productionInventory(bridge);
    assert.equal(production.length, RAW_CLI_REFERENCE.productionFiles);
    assert.equal(sourceDigest(JSON.stringify(production)), RAW_CLI_REFERENCE.productionInventorySHA256,
        'Production bytes differ from the independently frozen raw-CLI source.');
}
