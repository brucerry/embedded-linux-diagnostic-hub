'use strict';
// Non-shipping, explicit child entry. Copy these exact frozen bytes beside ownership.cjs.
const assert = require('node:assert/strict');
const path = require('node:path');
assert.equal(require.main, module);
assert.equal(process.argv.length, 3);
assert.equal(process.argv[1], __filename);
assert.ok(
    ['compatibility', 'ownership'].some(
        (mode) => process.argv[2] === path.join(__dirname, '..', 'child-input-' + mode + '.json'),
    ),
);
// Install before the first product/dependency import. Unknown acquisition owns a ref'ed fence.
const { registerHooks, isBuiltin } = require('node:module');
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
assert.equal(process.version, 'v24.22.0');
assert.deepEqual(process.execArgv, []);
assert.equal(process.env.NODE_OPTIONS, undefined);
assert.equal(process.env.NODE_PATH, undefined);
let uncertainHold;
const { createInstrumentedResolutionGuard } = require('./resolution-guard.cjs');
let guard;
try {
    guard = createInstrumentedResolutionGuard(__dirname, {
        registerHooks,
        isBuiltin,
        onViolation() {
            process.exitCode = 1;
        },
        onUncertain() {
            uncertainHold ??= setInterval(() => {}, 1000);
        },
    });
    require('./ownership.cjs')
        .activateInstrumentedGatewayChildFromFile(process.argv[2], guard)
        .catch(() => {
            process.exitCode = 1;
        });
} catch {
    process.exitCode = 1;
    if (guard) guard.retainFailure();
}
