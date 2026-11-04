// Pure actual-helper regressions; never import SDK or start the target.
import assert from 'node:assert/strict';
import { assessLoopbackOutcome } from './loopback-console-outcome.mjs';

const base = () => ({ result: { status: 'passed', errors: [] }, globalErrors: [],
    command: { schema: 1, exitCode: 0 }, stepOutcome: 'success', issues: [] });
let cases = 0;
function check(input, passed, problem) {
    const actual = assessLoopbackOutcome(input);
    assert.equal(actual.passed, passed);
    if (problem) assert.ok(actual.issues.includes(problem), problem);
    cases++;
    return actual;
}
check(base(), true);
const global = { message: 'global teardown failed' };
const local = { message: 'test teardown failed' };
const teardown = check({ ...base(), globalErrors: [global] }, false, 'global-report-errors');
assert.deepEqual(teardown.errors, [global]);
assert.equal(teardown.globalErrorCount, 1);
check({ ...base(), command: { schema: 1, exitCode: 1 } }, false, 'sdk-command-failed');
check({ ...base(), command: null }, false, 'sdk-command-outcome-unproved');
check({ ...base(), command: undefined, stepOutcome: undefined }, false, 'sdk-step-not-successful');
check({ ...base(), stepOutcome: 'cancelled' }, false, 'sdk-step-not-successful');
check({ ...base(), stepOutcome: 'failure' }, false, 'sdk-step-not-successful');
check({ ...base(), stepOutcome: 'skipped' }, false, 'sdk-step-not-successful');
check({ ...base(), result: { status: 'failed', errors: [] } }, false);
check({ ...base(), issues: ['retirement-unproved'] }, false, 'retirement-unproved');
const both = check({ ...base(), result: { status: 'passed', errors: [local] },
    globalErrors: [global] }, false, 'test-errors');
assert.deepEqual(both.errors, [local, global]);
check({ ...base(), globalErrors: {} }, false, 'invalid-global-errors');
check({ ...base(), result: { status: 'passed', errors: null } }, false, 'invalid-test-errors');
for (const exitCode of [-1, 0.5, 256, NaN, Infinity, '0'])
    check({ ...base(), command: { schema: 1, exitCode } }, false, 'sdk-command-outcome-unproved');
check({ ...base(), command: { schema: 2, exitCode: 0 } }, false, 'sdk-command-outcome-unproved');
const many = check({ ...base(), globalErrors: Array.from({ length: 12 }, () => global) }, false);
assert.equal(many.errors.length, 12); // Presentation caps must not cap acceptance checks.
assert.equal(many.globalErrorCount, 12);
const untouched = base();
assert.deepEqual(assessLoopbackOutcome(untouched).issues, []);
assert.deepEqual(untouched, base());
console.log(JSON.stringify({ cases, actualPureHelper: true, targetOrSdkExecuted: false }));
