// @ts-nocheck
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { pilotEvidenceReceiver } from '../scripts/lib/pilot-evidence-channel.mjs';
import { PilotEvidence } from '../scripts/lib/pilot-evidence.mjs';
import {
    startupIdentityDecoder,
    planStartupIdentity,
    identityManifestBudget,
} from '../scripts/lib/startup-identity-report.mjs';
const root = path.resolve(import.meta.dirname, '..');
const hash = (data) => createHash('sha256').update(data).digest('hex');
const loader = pathToFileURL(createRequire(path.join(root, 'package.json')).resolve('tsx')).href;
const profileDirectory = process.env.HUB_PILOT_ENTRY_PROFILE;
assert(
    profileDirectory,
    'Supply the retained qualification profile used by the real module-entry controls.',
);
const profile = path.join(profileDirectory, 'manifest.json');
const predecessorHashes = {
    'scripts/lib/startup-identity-report.mjs':
        'ccd5fc384906c217420efe2f76b73ae035cbe9d4eac95ad38d9efe27ef02aaae',
    'scripts/lib/pilot-runtime-startup.mjs':
        '6fb419f210afc7580673773873f03dda9834335046f1af1cb618a876ba5d1340',
};
function predecessorCopy(directory) {
    const target = path.join(directory, 'predecessor');
    const skip = new Set([
        'node_modules',
        '.git',
        'validation',
        'dist',
        'dist-web',
        'dist-site',
        'dist-gateway',
        'dist-electron',
        'release',
        'test-results',
    ]);
    fs.cpSync(root, target, {
        recursive: true,
        filter: (source) =>
            !path
                .relative(root, source)
                .split(path.sep)
                .some((part) => skip.has(part)),
    });
    fs.symlinkSync(
        fs.realpathSync(path.join(root, 'node_modules')),
        path.join(target, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
    );
    const restore = (relative, replacements) => {
        const file = path.join(target, relative);
        let text = fs.readFileSync(file, 'utf8');
        for (const [from, to] of replacements) {
            assert.equal(text.split(from).length, 2);
            text = text.replace(from, to);
        }
        assert.equal(
            hash(text),
            predecessorHashes[relative],
            'Red control must restore exact sealed predecessor bytes.',
        );
        fs.writeFileSync(file, text);
    };
    restore('scripts/lib/startup-identity-report.mjs', [
        [
            "    if (typeof emit.publishIdentity === 'function') return emit.publishIdentity(stage, data);\n    const plan = planStartupIdentity(stage, data);",
            "    const plan = planStartupIdentity(stage, data);\n    if (typeof emit.publishIdentity === 'function') return emit.publishIdentity(plan);",
        ],
    ]);
    restore('scripts/lib/pilot-runtime-startup.mjs', [
        [
            '                        // The IPC connected flag can lag a committed owned termination.\n                        // Do not admit a new credit write into that closing transport.\n                        if (child.connected && !startup.children.get(child)?.terminationRequested)',
            '                        if (child.connected)',
        ],
        [
            "import {\n    planStartupIdentity,\n    requireIdentityPlan,\n    reportingRefusal,\n} from './startup-identity-report.mjs';",
            "import { requireIdentityPlan, reportingRefusal } from './startup-identity-report.mjs';",
        ],
        [
            '    emit.publishIdentity = (stage, data) => {\n        const plan = planStartupIdentity(stage, data);',
            '    emit.publishIdentity = (plan) => {',
        ],
    ]);
    return target;
}
async function runCase(caseRoot, version, mode, evidenceDirectory) {
    fs.mkdirSync(evidenceDirectory);
    const journal = new PilotEvidence(evidenceDirectory),
        wire = [],
        scheduledACKs = [],
        sentACKs = [],
        holds = [],
        records = [];
    let charged = 0,
        control,
        stderr = '',
        stdoutBytes = 0,
        timedOut = false,
        inFlight = false,
        foreignPlanMessages = 0;
    const nonce = randomUUID(),
        binding = 'b'.repeat(64),
        state = { sequence: 0, runtimeDeadline: Infinity };
    const expectedSuccess = mode === 'esm' || (version === 'owner-planned' && mode === 'ts');
    const entry = path.join(caseRoot, 'tests/fixtures/pilot-plan-boundary-child.mts');
    const args = [
        '--import',
        loader,
        entry,
        JSON.stringify({ nonce, binding, mode, profile, expectedSuccess }),
    ];
    const child = spawn(process.execPath, args, {
        cwd: caseRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const reserve = (n) => {
        assert(charged + n <= 10485760);
        charged += n;
    };
    const record = (stage, data) => {
        reserve(Buffer.byteLength(JSON.stringify({ stage, data })) + 256);
        journal.append(stage, data);
        records.push({ stage, data });
    };
    const receiver = pilotEvidenceReceiver({
        nonce,
        bindingSHA256: binding,
        stage: 'native-electron-store',
        state,
        record,
        reserve,
        recordReserved: (stage, data) => {
            journal.append(stage, data);
            records.push({ stage, data });
        },
        send: (message, callback) => {
            scheduledACKs.push(message);
            // Receiver invokes this only after actual PilotEvidence append/fsync.
            setTimeout(() => {
                inFlight = false;
                sentACKs.push(message);
                child.send(message, callback);
            }, 2);
        },
        hold: (error) => holds.push(String(error)),
        clock: () => 0,
    });
    let exited;
    child.on('exit', (code, signal) => {
        exited = { code, signal };
    });
    child.stderr.on('data', (bytes) => {
        stderr += bytes;
        assert(Buffer.byteLength(stderr) <= 65536);
    });
    child.stdout.on('data', (bytes) => {
        stdoutBytes += bytes.length;
        assert(stdoutBytes <= 65536);
    });
    child.on('message', (message) => {
        if (message.kind === 'pilot-evidence') {
            assert.equal(inFlight, false, 'One outstanding durable evidence credit');
            inFlight = true;
            wire.push(message);
            receiver.receive(message);
        } else if (message.kind === 'foreign-plan-ready') {
            assert.equal(mode, 'serialized');
            foreignPlanMessages++;
            const plan = planStartupIdentity('actual-native-product', { safe: true });
            // Default JSON IPC strips generator functions and cannot preserve module-private membership.
            child.send({ kind: 'foreign-plan', plan });
        } else if (message.kind === 'plan-boundary-result') {
            assert.equal(sentACKs.length, wire.length, 'No result before all durable ACKs');
            control = message;
        } else assert.fail('Unexpected child control message');
    });
    const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
    }, 10000);
    const closed = await new Promise((resolve) =>
        child.once('close', (code, signal) => resolve({ code, signal })),
    );
    clearTimeout(timeout);
    const journalClosed = journal.close();
    assert.equal(journalClosed.complete, true);
    assert.equal(timedOut, false, stderr);
    assert.deepEqual(exited, closed);
    assert.equal(closed.code, 0, stderr);
    assert.equal(closed.signal, null);
    assert.equal(stdoutBytes, 0);
    assert(control, stderr);
    assert.equal(control.node, 'v24.22.0');
    assert.equal(control.tsx, '4.23.15');
    assert(
        control.nativeHostCJSReporterMatchesTypedCarrier &&
            control.nativeHostFunctionNotCalled &&
            control.packageTypeAbsent &&
            control.CJSOwnPlanAccepted,
    );
    assert.equal(control.sameMaker, false);
    assert.equal(control.sameValidator, false);
    assert.match(control.foreignPlanError, /validated plan/);
    assert.equal(control.pid, child.pid);
    assert.equal(control.loader, createRequire(path.join(caseRoot, 'package.json')).resolve('tsx'));
    assert(control.execArgvAfterStageStylePreload.includes('--require'));
    assert.equal(
        control.execArgvAfterStageStylePreload[
            control.execArgvAfterStageStylePreload.indexOf('--import') + 1
        ],
        loader,
    );
    assert.equal(
        control.moduleSHA256,
        hash(fs.readFileSync(path.join(caseRoot, 'scripts/lib/startup-identity-report.mjs'))),
    );
    assert.equal(foreignPlanMessages, mode === 'serialized' ? 1 : 0);
    assert.equal(holds.length, 0);
    let restored;
    if (expectedSuccess) {
        assert.equal(control.result, 'published');
        assert.equal(control.error, undefined);
        receiver.assertComplete();
        assert.equal(wire.length, sentACKs.length);
        assert.equal(scheduledACKs.length, sentACKs.length);
        const decoder = startupIdentityDecoder();
        for (const record of records) {
            const stage = record.stage.slice('native-electron-store:'.length);
            if (stage === 'startup-identity-manifest' || stage === 'startup-identity-part')
                restored = decoder.accept(stage, record.data) || restored;
            else decoder.assertComplete();
        }
        decoder.assertComplete();
        assert(restored);
        assert.equal(
            JSON.stringify({ stage: restored.stage, data: restored.data }),
            JSON.stringify({
                stage: 'actual-native-product',
                data: {
                    marker: 'before',
                    payload: '界'.repeat(25000),
                    artifactSHA256: 'c'.repeat(64),
                },
            }),
        );
        assert.equal(records.at(-1).stage, 'native-electron-store:after-publication');
        assert.equal(wire[0].stage, 'startup-identity-manifest');
        assert(wire.slice(1, -1).every((message) => message.stage === 'startup-identity-part'));
        const later = {
            stage: 'native-electron-store:after-publication',
            data: { complete: true },
        };
        assert.equal(
            charged,
            identityManifestBudget(wire[0].data).chargedBytes +
                Buffer.byteLength(JSON.stringify(later)) +
                256,
        );
        assert(wire.every((message) => Buffer.byteLength(JSON.stringify(message)) <= 65536));
    } else {
        assert(control.error);
        assert.equal(wire.length, 0);
        assert.equal(sentACKs.length, 0);
        assert.equal(records.length, 0);
        assert.equal(charged, 0);
        if (['ts', 'serialized', 'forged'].includes(mode))
            assert.match(control.error, /validated plan/);
        if (['old-plan-api', 'invalid-stage'].includes(mode))
            assert.match(control.error, /stage allowlist/);
        if (mode === 'overbudget') assert.equal(control.reportingFailure.counter, 'logicalBytes');
    }
    const journalBytes = fs.readFileSync(path.join(evidenceDirectory, 'pilot.jsonl'));
    const journalSHA256 = hash(journalBytes);
    fs.writeFileSync(
        path.join(evidenceDirectory, 'wire.json'),
        JSON.stringify(wire, null, 2) + '\n',
    );
    fs.writeFileSync(
        path.join(evidenceDirectory, 'durable-acks.json'),
        JSON.stringify(sentACKs, null, 2) + '\n',
    );
    fs.writeFileSync(
        path.join(evidenceDirectory, 'child-control.json'),
        JSON.stringify(control, null, 2) + '\n',
    );
    if (process.env.HUB_PLAN_BOUNDARY_EVIDENCE) {
        const retained = path.resolve(process.env.HUB_PLAN_BOUNDARY_EVIDENCE, version + '-' + mode);
        assert(
            !fs.existsSync(retained),
            'Preserve earlier process evidence; use a fresh output directory.',
        );
        fs.cpSync(evidenceDirectory, retained, { recursive: true });
    }
    return {
        version,
        mode,
        expectedSuccess,
        argv: [process.execPath, ...args],
        cwd: caseRoot,
        control,
        journalBytes: journalBytes.length,
        journalSHA256,
        retainedEvidenceCase: version + '-' + mode,
        wireFrames: wire.length,
        durableACKs: sentACKs.length,
        fullWireMaxBytes: Math.max(0, ...wire.map((m) => Buffer.byteLength(JSON.stringify(m)))),
        chargedBytes: charged,
        actualExit: exited,
        actualPipeClose: closed,
        journalClosed,
        holds,
        stderr,
        serializedForeignPlanControlMessages: foreignPlanMessages,
        snapshotMarkerBeforeMutation: restored?.data.marker,
        actualJSONIPC: true,
        actualProductionRuntimeChannelReceiverAndFsyncJournal: true,
        mockedReporterOrVMNamespace: false,
        nativeFactoryOrPayloadCalled: false,
        WindowsNativeQualification: false,
    };
}
test('real ESM/CJS same-process plan ownership through actual child entry, IPC, receiver and fsync journal', async (t) => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hub-plan-boundary-'));
    const original = predecessorCopy(directory);
    try {
        const results = [];
        for (const [version, caseRoot] of [
            ['sealed-predecessor', original],
            ['owner-planned', root],
        ]) {
            const modes = [
                'esm',
                'ts',
                'serialized',
                'forged',
                ...(version === 'owner-planned'
                    ? ['old-plan-api', 'invalid-stage', 'overbudget']
                    : []),
            ];
            for (const mode of modes)
                await t.test(version + '/' + mode, async () => {
                    const result = await runCase(
                        caseRoot,
                        version,
                        mode,
                        path.join(directory, version + '-' + mode),
                    );
                    results.push(result);
                    t.diagnostic(JSON.stringify({ kind: 'real-plan-boundary-case', ...result }));
                });
        }
        assert.equal(results.length, 11);
    } finally {
        fs.rmSync(directory, { recursive: true });
    }
});
