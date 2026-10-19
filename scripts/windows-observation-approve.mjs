import assert from 'node:assert/strict';
import fs from 'node:fs';
// This approval-only job has no dependency install, collector import, process spawn or payload.
assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
assert.equal(process.env.GITHUB_REPOSITORY, 'brucerry/embedded-linux-diagnostic-hub');
assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1');
assert.equal(process.env.GITHUB_ACTOR, 'brucerry');
assert.equal(process.env.GITHUB_TRIGGERING_ACTOR, 'brucerry');
const raw = process.env.OBSERVATION_APPROVAL_JSON;
assert(typeof raw === 'string' && Buffer.byteLength(raw) <= 8192);
const value = JSON.parse(raw);
assert.deepEqual(Object.keys(value).sort(), [
    'bindingSHA256',
    'commit',
    'decision',
    'parentRun',
    'schema',
    'sourceSHA256',
]);
assert.equal(value.schema, 1);
assert.equal(value.decision, 'approve-one-normal-pair');
assert(/^[1-9]\d{0,19}$/.test(value.parentRun));
for (const key of ['bindingSHA256', 'sourceSHA256']) assert(/^[a-f0-9]{64}$/.test(value[key]));
assert.equal(value.commit, process.env.GITHUB_SHA);
assert(/^[a-f0-9]{40}$/.test(value.commit));
assert.notEqual(value.parentRun, process.env.GITHUB_RUN_ID);
fs.writeFileSync('approval.json', JSON.stringify(value) + '\n', { flag: 'wx' });
fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    'artifact_name=windows-observation-approval-' +
        value.parentRun +
        '-' +
        value.bindingSHA256 +
        '\n',
);
