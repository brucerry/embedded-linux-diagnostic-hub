'use strict';
// Non-shipping, explicit child entry. Copy these exact frozen bytes beside ownership.cjs.
const assert = require('node:assert/strict');
const path = require('node:path');
assert.equal(require.main, module);
assert.equal(process.argv.length, 3);
assert.equal(process.argv[1], __filename);
assert.ok(['compatibility', 'ownership'].some(mode => process.argv[2] === path.join(__dirname, '..', 'child-input-' + mode + '.json')));
require('./ownership.cjs').activateInstrumentedGatewayChildFromFile(process.argv[2]).catch(() => {
    process.exitCode = 1;
});
