import {
    startupIdentityDecoder,
    identityManifestStage,
    identityPartStage,
    reportLifecycleEvidence,
} from '../scripts/lib/startup-identity-report.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import ts from 'typescript';
import { runNativeCleanup } from './fixtures/memory-product-native-cleanup';

// Extract the actual shutdown step, rather than reproducing its ordering in a mock helper.
const source = fs.readFileSync(
    new URL('./fixtures/memory-product-native-host.ts', import.meta.url),
    'utf8',
);
const ast = ts.createSourceFile('host.ts', source, ts.ScriptTarget.Latest, true);
let body = '';
function visit(node: ts.Node) {
    if (ts.isObjectLiteralExpression(node)) {
        const name = node.properties.find(
            (p) => ts.isPropertyAssignment(p) && p.name.getText(ast) === 'name',
        ) as ts.PropertyAssignment | undefined;
        if (
            name &&
            ts.isStringLiteral(name.initializer) &&
            name.initializer.text === 'request-actual-product-shutdown'
        ) {
            const run = node.properties.find(
                (p) => ts.isPropertyAssignment(p) && p.name.getText(ast) === 'run',
            ) as ts.PropertyAssignment;
            body = run.initializer.getText(ast);
        }
    }
    ts.forEachChild(node, visit);
}
visit(ast);
assert(body);

function step(
    snapshot: (() => unknown) | undefined,
    emit: (stage: string, data: any) => Promise<void>,
) {
    let requests = 0;
    const module = { exports: {} as any };
    const decoder = startupIdentityDecoder();
    const wireEmit = async (stage: string, data: any) => {
        if (stage === identityManifestStage || stage === identityPartStage) {
            const value = decoder.accept(stage, data);
            if (value) await emit(value.stage, value.data);
        } else {
            decoder.assertComplete();
            await emit(stage, data);
        }
    };
    const realm: any = {
        reportLifecycleEvidence,
        __memoryNativeQualification: snapshot ? { snapshot } : undefined,
        __memoryNativeQuit: {
            request() {
                requests++;
            },
        },
        options: { emit: wireEmit },
        module,
        exports: module.exports,
    };
    realm.application = { evaluate: async (callback: () => unknown) => callback() };
    const code = transformSync('export default ' + body, {
        loader: 'ts',
        format: 'cjs',
        target: 'node24',
    }).code;
    vm.runInNewContext(code, realm);
    return { run: module.exports.default as () => Promise<void>, requests: () => requests };
}

for (const mode of ['success', 'throw', 'missing', 'pending'] as const) {
    test(`shutdown request is admitted independently of ${mode} snapshot`, async () => {
        const receipts: any[] = [];
        const snapshot =
            mode === 'missing'
                ? undefined
                : () => {
                      if (mode === 'throw') throw Error('controlled diagnostic failure');
                      if (mode === 'pending') return new Promise(() => {});
                      return { capture: { observed: true } };
                  };
        const f = step(snapshot, async (stage, data) => {
            receipts.push({ stage, data });
        });
        let later = 0;
        await runNativeCleanup(
            [
                { name: 'request', run: f.run },
                {
                    name: 'later-disposer',
                    run: async () => {
                        later++;
                    },
                },
            ],
            async () => {},
        );
        assert.equal(f.requests(), 1);
        assert.equal(later, 1);
        assert.equal(receipts[0].data.available, mode === 'success');
        assert.equal(
            receipts[0].stage,
            mode === 'success'
                ? 'native-product-shutdown-request'
                : 'native-product-shutdown-snapshot-unavailable',
        );
        if (mode !== 'success')
            assert.equal(
                receipts[0].data.snapshot,
                undefined,
                'Unavailable diagnostics must not manufacture owners.',
            );
    });
}

test('receipt failure after snapshot does not skip quit or later disposers', async () => {
    const failure = Error('controlled receipt failure');
    const f = step(
        () => ({ observed: true }),
        async () => {
            throw failure;
        },
    );
    let later = 0;
    await assert.rejects(
        runNativeCleanup(
            [
                { name: 'request', run: f.run },
                {
                    name: 'later',
                    run: async () => {
                        later++;
                    },
                },
            ],
            async () => {},
        ),
        AggregateError,
    );
    assert.equal(f.requests(), 1);
    assert.equal(later, 1);
});

test('pending receipt cannot defer quit or prevent later cleanup admission at the existing cutoff', async () => {
    const f = step(
        () => ({ observed: true }),
        async () => new Promise(() => {}),
    );
    let time = 0,
        later = 0;
    const timers: { callback: () => void; ms: number }[] = [];
    const clock = {
        now: () => time,
        set: (callback: () => void, ms: number) => {
            const t = { callback, ms };
            timers.push(t);
            return t;
        },
        clear: () => {},
    };
    const work = runNativeCleanup(
        [
            { name: 'request', run: f.run },
            {
                name: 'later',
                run: async () => {
                    later++;
                },
            },
        ],
        async () => {},
        { clock },
    );
    const rejected = assert.rejects(work, AggregateError);
    for (let n = 0; n < 20; n++) await Promise.resolve();
    assert.equal(f.requests(), 1);
    assert.equal(timers[0].ms, 10000);
    time = 10000;
    timers[0].callback();
    await rejected;
    assert.equal(later, 1);
});
