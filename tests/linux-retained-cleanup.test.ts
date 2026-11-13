/** Actual cleanup controller with closed MapFS/manual ports only. No native load or real deletion. */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { readFileSync } from 'node:fs';
import * as model from '../electron/linux-transaction-model.ts';
import * as installation from '../shared/installation.ts';

const root = new URL('../', import.meta.url),
    sourceURL = new URL('electron/linux-retained-cleanup.ts', root),
    maintenanceURL = new URL('electron/installation-maintenance.ts', root),
    admitted = new Set([sourceURL.href, maintenanceURL.href]),
    read = (url: URL) => {
        assert.ok(admitted.has(url.href));
        return readFileSync(url, 'utf8');
    };
const maintenanceTree = ts.createSourceFile(
        'fixed-maintenance.ts',
        read(maintenanceURL),
        ts.ScriptTarget.ES2022,
        true,
    ),
    declarations = maintenanceTree.statements
        .flatMap((node) =>
            ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [],
        )
        .filter((node) => ts.isIdentifier(node.name) && node.name.text === 'SETUP_OWNER');
assert.equal(declarations.length, 1);
assert.ok(declarations[0].initializer && ts.isStringLiteral(declarations[0].initializer));
const SETUP_OWNER = declarations[0].initializer.text;
const source = read(sourceURL),
    tree = ts.createSourceFile('linux-retained-cleanup.ts', source, ts.ScriptTarget.ES2022, true),
    modules = new Map<string, unknown>([
        ['node:path', path],
        ['node:crypto', { createHash }],
        ['node:util', { types: utilTypes }],
        ['./linux-transaction-model.ts', model],
        ['../shared/installation.ts', installation],
        ['./installation-maintenance.ts', { SETUP_OWNER }],
    ]);
assert.equal(
    (tree as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.length,
    0,
);
for (const node of tree.statements)
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly)
        assert.ok(
            ts.isStringLiteral(node.moduleSpecifier) && modules.has(node.moduleSpecifier.text),
            'Closed runtime import.',
        );
const compiled = ts.transpileModule(source, {
    fileName: 'linux-retained-cleanup.ts',
    reportDiagnostics: true,
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
    },
});
assert.equal(
    (compiled.diagnostics ?? []).filter((item) => item.category === ts.DiagnosticCategory.Error)
        .length,
    0,
);
const module = { exports: {} as any },
    refuse = () => {
        throw Error('UNADMITTED_REAL_PORT');
    },
    context = vm.createContext(
        {
            module,
            exports: module.exports,
            Object,
            JSON,
            Map,
            Set,
            Buffer,
            Error,
            Promise,
            TextDecoder,
            process: Object.freeze({}),
            performance: Object.freeze({ now: refuse }),
            setTimeout: refuse,
            clearTimeout: refuse,
            require(name: string) {
                assert.ok(modules.has(name));
                return modules.get(name);
            },
        },
        { codeGeneration: { strings: false, wasm: false } },
    );
new vm.Script(compiled.outputText, { filename: 'linux-retained-cleanup.memory.cjs' }).runInContext(
    context,
    { timeout: 1000 },
);
const createLinuxRetainedCleanup = module.exports.createLinuxRetainedCleanup;
assert.equal(typeof createLinuxRetainedCleanup, 'function');
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex'),
    clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)),
    id = '11111111-1111-4111-8111-111111111111',
    txA = '22222222-2222-4222-8222-222222222222',
    txB = '33333333-3333-4333-8333-333333333333';
type Node = {
    path: string;
    kind: 'file' | 'directory' | 'link';
    ino: number;
    uid: number;
    mode: number;
    nlink: number;
    bytes: Buffer;
};
function memory() {
    const nodes = new Map<string, Node>(),
        calls: { name: string; file?: string }[] = [];
    let ino = 10,
        after: (name: string, file: string) => void = () => {},
        beforeGuard: () => Promise<void> | void = () => {},
        live = true,
        returnValue: unknown;
    const parent = (name: string) => path.posix.dirname(name),
        directory = (
            name: string,
            uid = name.startsWith('/home/test') ? 1000 : 0,
            mode = 0o700,
        ) => {
            if (nodes.has(name)) return nodes.get(name)!;
            if (name !== '/') directory(parent(name));
            const node: Node = {
                path: name,
                kind: 'directory',
                ino: ino++,
                uid,
                mode: 0o40000 | mode,
                nlink: 1,
                bytes: Buffer.alloc(0),
            };
            nodes.set(name, node);
            return node;
        },
        file = (name: string, bytes: string | Buffer, mode = 0o600) => {
            directory(parent(name));
            const node: Node = {
                path: name,
                kind: 'file',
                ino: ino++,
                uid: 1000,
                mode: 0o100000 | mode,
                nlink: 1,
                bytes: Buffer.from(bytes),
            };
            nodes.set(name, node);
            return node;
        },
        node = (name: string) => {
            const result = nodes.get(name);
            if (!result) throw Object.assign(Error('MapFS missing'), { code: 'ENOENT' });
            return result;
        },
        stat = (name: string) => {
            const n = node(name);
            return {
                dev: 1,
                ino: n.ino,
                uid: n.uid,
                mode: n.mode,
                nlink: n.nlink,
                size: n.bytes.length,
                isFile: () => n.kind === 'file',
                isDirectory: () => n.kind === 'directory',
                isSymbolicLink: () => n.kind === 'link',
            };
        },
        host = {
            platform: 'linux',
            arch: 'x64',
            uid: 1000,
            euid: 1000,
            home: '/home/test',
            appData: '/home/test/data',
            sourceRoot: '/home/test/source',
            version: '0.7.0',
        },
        installed = '/home/test/installed',
        profile = host.appData + '/DiagnosticHub/profiles/' + id,
        owner = {
            pid: 777,
            startTicks: '9999',
            executable: host.sourceRoot + '/app/diagnostic-hub',
        },
        manifest = (version: string, text: string) =>
            installation.validateInstallationManifest({
                schemaVersion: 1,
                product: installation.INSTALLATION_PRODUCT,
                layout: 'linux-folder',
                platform: 'linux',
                arch: 'x64',
                version,
                sourceCommit: (version === '0.6.0' ? 'a' : 'b').repeat(40),
                entryPoint: 'app/diagnostic-hub',
                files: [
                    {
                        kind: 'file',
                        path: 'app/diagnostic-hub',
                        bytes: Buffer.byteLength(text),
                        sha256: hash(text),
                    },
                ],
            }),
        a = manifest('0.6.0', 'old-app'),
        b = manifest('0.7.0', 'new-app'),
        digestA = hash(JSON.stringify(a)),
        digestB = hash(JSON.stringify(b)),
        work = '/home/test/.DiagnosticHub-maintenance-' + hash(installed).slice(0, 20),
        previous = work + '/previous-' + txB,
        ledger = work + '-finalize-' + txB;
    for (const name of [host.home, host.appData, host.sourceRoot, installed, previous, work])
        directory(name);
    file(previous + '/app/diagnostic-hub', 'old-app', 0o755);
    file(previous + '/' + installation.INSTALLATION_MANIFEST, JSON.stringify(a));
    file(
        previous + '/' + installation.INSTALLATION_RECORD,
        JSON.stringify({
            schemaVersion: 1,
            product: installation.INSTALLATION_PRODUCT,
            installationId: id,
            manifestSHA256: digestA,
            profile: 'dedicated',
        }),
    );
    file(
        previous + '/' + SETUP_OWNER,
        JSON.stringify({
            schemaVersion: 1,
            product: installation.INSTALLATION_PRODUCT,
            root: installed,
            installationId: id,
            transactionId: txA,
            options: { startMenu: false, desktop: false, launch: false },
            integrations: [],
        }),
    );
    file(installed + '/app/diagnostic-hub', 'new-app', 0o755);
    file(profile + '/reports', 'private settings and reports');
    const journal = (
            transactionId: string,
            candidateSHA256: string,
            previousSHA256: string | null,
        ) => ({
            schemaVersion: 1,
            root: installed,
            uid: 1000,
            transactionId,
            installationId: id,
            profile,
            candidateSHA256,
            previousSHA256,
            owner: clone(owner),
            phase: 'candidate-active',
        }),
        journalA = journal(txA, digestA, null),
        journalB = journal(txB, digestB, digestA),
        rawA = Buffer.from(JSON.stringify(journalA)),
        rawB = Buffer.from(JSON.stringify(journalB));
    file(work + '/completed-journal.json', rawA);
    file(work + '/journal.json', rawB);
    const view: any = {
        activity: { root: 'inactive', stage: 'inactive', previous: 'inactive' },
        parents: ['/', '/home', '/home/test', '/home/test/data', '/home/test/source'].map(
            (name) => ({
                path: name,
                dev: 1,
                ino: node(name).ino,
                uid: node(name).uid,
                mode: node(name).mode,
            }),
        ),
        source: {
            identity: { uid: 1000, dev: 1, ino: node(host.sourceRoot).ino },
            manifest: b,
            verifiedManifestSHA256: digestB,
        },
        root: {
            identity: { uid: 1000, dev: 1, ino: node(installed).ino },
            manifest: b,
            verifiedManifestSHA256: digestB,
            installationId: id,
            transactionId: txB,
            root: installed,
            profile,
        },
        previous: {
            identity: { uid: 1000, dev: 1, ino: node(previous).ino },
            manifest: a,
            verifiedManifestSHA256: digestA,
            installationId: id,
            transactionId: txA,
            root: installed,
            profile,
        },
        stage: null,
        journal: journalB,
        history: {
            journalOriginal: { base64: rawB.toString('base64'), sha256: hash(rawB) },
            completed: { base64: rawA.toString('base64'), sha256: hash(rawA), journal: journalA },
        },
    };
    const configuration: any = {
        host,
        root: installed,
        action: 'finalize',
        installationId: id,
        transactionId: txB,
        owner,
    };
    model.checkedLinuxModelView(view, configuration);
    const keep = new Map(
        [...nodes]
            .filter(([name, item]) => item.kind === 'file' && !name.startsWith(previous + '/'))
            .map(([name, item]) => [name, item.bytes.toString('base64')]),
    );
    const verifyKeep = () => {
            for (const [name, bytes] of keep)
                assert.equal(node(name).bytes.toString('base64'), bytes);
        },
        match = (name: string, expected: any) => {
            const s = stat(name);
            for (const key of ['dev', 'ino', 'uid', 'mode'])
                assert.equal((s as any)[key], expected[key]);
        },
        record = (name: string, value: string) => {
            calls.push({ name, file: value });
            after(name, value);
        };
    const io: any = {
        configuration: () => clone(configuration),
        initial: async () => clone(view),
        stat,
        maybe: (name: string) => (nodes.has(name) ? stat(name) : null),
        names: (name: string) => {
            assert.equal(node(name).kind, 'directory');
            return [...nodes.keys()]
                .filter((key) => key !== name && parent(key) === name)
                .map((key) => path.posix.basename(key));
        },
        read: (name: string, cap: number) => {
            assert.equal(node(name).kind, 'file');
            assert.ok(node(name).bytes.length <= cap);
            return Buffer.from(node(name).bytes);
        },
        hash: (name: string, size: number) => {
            assert.equal(node(name).bytes.length, size);
            return hash(node(name).bytes);
        },
        mkdir: (name: string) => {
            assert.equal(nodes.has(name), false);
            assert.equal(node(parent(name)).kind, 'directory');
            directory(name);
            record('mkdir', name);
            return returnValue;
        },
        write: (name: string, raw: Buffer, exclusive: boolean, prior?: Buffer) => {
            if (exclusive) {
                assert.equal(nodes.has(name), false);
                file(name, raw);
            } else {
                assert.deepEqual(node(name).bytes, prior);
                node(name).bytes = Buffer.from(raw);
            }
            record('write', name);
            return returnValue;
        },
        move: (from: string, to: string, expected: any) => {
            match(from, expected);
            assert.equal(nodes.has(to), false);
            assert.equal(node(parent(to)).kind, 'directory');
            const moving = [...nodes].filter(
                ([name]) => name === from || name.startsWith(from + '/'),
            );
            for (const [name] of moving) nodes.delete(name);
            for (const [name, item] of moving) {
                item.path = to + name.slice(from.length);
                nodes.set(item.path, item);
            }
            record('move', to);
            return returnValue;
        },
        remove: (name: string, expected: any) => {
            assert.equal(name, ledger + '/disposal/entry');
            match(name, expected);
            if (node(name).kind === 'directory') assert.equal(io.names(name).length, 0);
            nodes.delete(name);
            record('remove', name);
            return returnValue;
        },
        guard: async () => {
            calls.push({ name: 'guard' });
            await beforeGuard();
            verifyKeep();
        },
        live: () => {
            calls.push({ name: 'live' });
            if (!live) throw Error('MEMORY_LIVE_REFUSED');
        },
    };
    return {
        nodes,
        node,
        file,
        directory,
        io,
        calls,
        configuration,
        view,
        previous,
        ledger,
        work,
        installed,
        profile,
        rawA,
        rawB,
        keep,
        verifyKeep,
        setAfter(value: typeof after) {
            after = value;
        },
        setGuard(value: typeof beforeGuard) {
            beforeGuard = value;
        },
        setLive(value: boolean) {
            live = value;
        },
        setReturn(value: unknown) {
            returnValue = value;
        },
        create: () => createLinuxRetainedCleanup(io),
        json: (name: string) => JSON.parse(node(name).bytes.toString()),
    };
}
const effects = (f: ReturnType<typeof memory>) =>
    f.calls.filter((call) => ['mkdir', 'write', 'move', 'remove'].includes(call.name));
async function thrown(operation: Promise<unknown>) {
    return operation.then(
        () => ({ returned: true as const }),
        (error: unknown) => ({ error }),
    );
}

test('retained cleanup removes only the manifest-bound predecessor and retains current profile and originals', async () => {
    const f = memory(),
        cleanup = f.create(),
        review = await cleanup.inspect(),
        originalMetadata = clone(review.snapshot.originals);
    assert.equal(review.kind, 'fresh');
    const result = await cleanup.run(review);
    assert.equal(result.progress.phase, 'complete');
    assert.equal(f.nodes.has(f.previous), false);
    assert.equal(f.nodes.has(f.ledger + '/payload'), false);
    assert.deepEqual(f.io.names(f.ledger + '/disposal'), []);
    f.verifyKeep();
    assert.deepEqual(f.json(f.ledger + '/snapshot.json').originals, originalMetadata);
    assert.equal(
        effects(f).filter((call) => call.name === 'remove').length,
        review.snapshot.entries.length,
    );
    assert.equal(cleanup.stored().progress.phase, 'complete');
});

test('every issued memory effect follows an awaited guard and immediate live check', async () => {
    const f = memory(),
        cleanup = f.create();
    await cleanup.run(await cleanup.inspect());
    for (let at = 0; at < f.calls.length; at++)
        if (['mkdir', 'write', 'move', 'remove'].includes(f.calls[at].name)) {
            assert.equal(f.calls[at - 1].name, 'live');
            assert.equal(f.calls[at - 2].name, 'guard');
        }
    assert.ok(effects(f).length > 10);
    f.verifyKeep();
});

test('unknown inventory or changed predecessor metadata refuses before any effect', async () => {
    for (const mode of ['extra', 'metadata', 'link', 'owner', 'alias']) {
        const f = memory();
        if (mode === 'extra') f.file(f.previous + '/unlisted', 'unlisted');
        if (mode === 'metadata')
            f.node(f.previous + '/' + installation.INSTALLATION_RECORD).bytes[0] ^= 1;
        if (mode === 'link') f.node(f.previous + '/app/diagnostic-hub').kind = 'link';
        if (mode === 'owner') f.node(f.previous + '/app/diagnostic-hub').uid = 2000;
        if (mode === 'alias') f.node(f.previous + '/app/diagnostic-hub').nlink = 2;
        const result = await thrown(f.create().inspect());
        assert.ok('error' in result, mode);
        assert.equal(effects(f).length, 0, mode);
    }
});

test('changing the inspected preimage cannot begin cleanup', async () => {
    const f = memory(),
        cleanup = f.create(),
        review = await cleanup.inspect();
    f.node(f.previous + '/app/diagnostic-hub').bytes[0] ^= 1;
    assert.ok('error' in (await thrown(cleanup.run(review))));
    assert.equal(effects(f).length, 0);
    f.verifyKeep();
});

test('lost unlink acknowledgement retains thrown undefined and resumes only its issued absence', async () => {
    const f = memory(),
        cleanup = f.create(),
        review = await cleanup.inspect();
    let first = true;
    f.setAfter((name) => {
        if (name === 'remove' && first) {
            first = false;
            throw undefined;
        }
    });
    const failure = await thrown(cleanup.run(review));
    assert.ok('error' in failure);
    assert.equal(failure.error, undefined);
    assert.equal(cleanup.diagnostics().primarySet, true);
    assert.equal(cleanup.diagnostics().pending, 'entry-remove');
    assert.equal(f.json(f.ledger + '/state.json').leaf, 'unlink-issued');
    assert.equal(effects(f).filter((call) => call.name === 'remove').length, 1);
    const at = effects(f).length;
    assert.ok('error' in (await thrown(cleanup.run(review))));
    assert.equal(effects(f).length, at);
    f.setAfter(() => {});
    const restart = f.create(),
        resumed = await restart.run(await restart.inspect());
    assert.equal(resumed.progress.phase, 'complete');
    assert.equal(
        effects(f).filter((call) => call.name === 'remove').length,
        review.snapshot.entries.length,
    );
    f.verifyKeep();
});

test('lost predecessor or entry move acknowledgement is reconciled from exact one-sided postimage', async () => {
    for (const target of ['payload', 'disposal/entry']) {
        const f = memory(),
            cleanup = f.create(),
            review = await cleanup.inspect(),
            primary = Error('memory move ack');
        let once = true;
        f.setAfter((name, file) => {
            if (name === 'move' && file === f.ledger + '/' + target && once) {
                once = false;
                throw primary;
            }
        });
        const outcome = await thrown(cleanup.run(review));
        assert.ok('error' in outcome);
        assert.equal(outcome.error, primary);
        assert.equal(cleanup.diagnostics().primarySet, true);
        f.setAfter(() => {});
        const restart = f.create();
        assert.equal((await restart.run(await restart.inspect())).progress.phase, 'complete');
        assert.equal(
            effects(f).filter((call) => call.name === 'move' && call.file === f.ledger + '/payload')
                .length,
            1,
        );
        f.verifyKeep();
    }
});

test('unissued missing staged entry and foreign partial payload refuse without further effect', async () => {
    for (const mode of ['unissued-absence', 'foreign', 'changed-entry']) {
        const f = memory(),
            cleanup = f.create();
        let first = true;
        f.setAfter((name, file) => {
            if (
                name === 'write' &&
                file === f.ledger + '/state.json' &&
                first &&
                f.json(file).leaf === 'staged'
            ) {
                first = false;
                throw Error('authored stop');
            }
        });
        assert.ok('error' in (await thrown(cleanup.run(await cleanup.inspect()))));
        f.setAfter(() => {});
        if (mode === 'unissued-absence') f.nodes.delete(f.ledger + '/disposal/entry');
        if (mode === 'foreign') f.file(f.ledger + '/payload/unlisted', 'foreign');
        if (mode === 'changed-entry') f.node(f.ledger + '/disposal/entry').bytes[0] ^= 1;
        const at = effects(f).length;
        assert.ok('error' in (await thrown(f.create().inspect())), mode);
        assert.equal(effects(f).length, at);
        f.verifyKeep();
    }
});

test('a late guard completion cannot issue an effect after owned live authority is refused', async () => {
    const f = memory(),
        cleanup = f.create(),
        review = await cleanup.inspect();
    let resume!: () => void, entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
            entered = resolve;
        }),
        gate = new Promise<void>((resolve) => {
            resume = resolve;
        });
    f.setGuard(async () => {
        entered();
        await gate;
    });
    const operation = thrown(cleanup.run(review));
    await enteredPromise;
    assert.equal(effects(f).length, 0);
    f.setLive(false);
    resume();
    assert.ok('error' in (await operation));
    assert.equal(effects(f).length, 0);
    assert.equal(f.nodes.has(f.ledger), false);
    f.verifyKeep();
});

test('partial ledger initialization is retained and never reconstructed or cleaned automatically', async () => {
    for (const target of ['snapshot.json', 'state.json']) {
        const f = memory(),
            cleanup = f.create(),
            primary = Error('memory state ack');
        f.setAfter((name, file) => {
            if (name === 'write' && file === f.ledger + '/' + target) throw primary;
        });
        const result = await thrown(cleanup.run(await cleanup.inspect()));
        assert.ok('error' in result);
        assert.equal(result.error, primary);
        assert.equal(f.nodes.has(f.previous), true);
        assert.equal(
            effects(f).some((call) => call.name === 'move'),
            false,
        );
        f.setAfter(() => {});
        const at = effects(f).length,
            restart = f.create();
        if (target === 'snapshot.json') assert.ok('error' in (await thrown(restart.inspect())));
        else assert.equal((await restart.inspect()).progress.phase, 'prepared');
        assert.equal(effects(f).length, at);
        f.verifyKeep();
    }
});

test('unsupported async filesystem return retains its owner without a second effect', async () => {
    const f = memory(),
        cleanup = f.create(),
        review = await cleanup.inspect();
    f.setReturn(Promise.resolve());
    const result = await thrown(cleanup.run(review));
    assert.ok('error' in result);
    assert.equal((result.error as Error).message, 'LINUX_FINALIZE_CLEANUP_ASYNC_OR_VALUE');
    assert.equal(effects(f).length, 1);
    assert.equal(cleanup.diagnostics().primarySet, true);
    assert.equal(cleanup.diagnostics().pending, 'ledger-create');
    assert.ok('error' in (await thrown(cleanup.run(review))));
    assert.equal(effects(f).length, 1);
    f.verifyKeep();
});

test('completed historical ledger remains readable under a later legitimate source actor', async () => {
    const f = memory(),
        cleanup = f.create();
    await cleanup.run(await cleanup.inspect());
    f.configuration.host.sourceRoot = '/home/test/new-source';
    f.configuration.host.version = '0.8.0';
    f.configuration.owner = {
        pid: 888,
        startTicks: '12345',
        executable: '/home/test/new-source/app/diagnostic-hub',
    };
    const at = effects(f).length,
        historical = f.create().stored();
    assert.equal(historical.progress.phase, 'complete');
    assert.equal(historical.snapshot.configuration.host.version, '0.7.0');
    assert.equal(effects(f).length, at);
    f.verifyKeep();
});

test('only exact preserved current and baseline originals are admitted beside a complete ledger', async () => {
    for (const mode of ['valid', 'changed', 'extra', 'premature']) {
        const f = memory(),
            cleanup = f.create();
        if (mode === 'premature') {
            let first = true;
            f.setAfter((name, file) => {
                if (name === 'write' && file === f.ledger + '/state.json' && first) {
                    first = false;
                    throw Error('memory stop');
                }
            });
            assert.ok('error' in (await thrown(cleanup.run(await cleanup.inspect()))));
            f.setAfter(() => {});
        } else await cleanup.run(await cleanup.inspect());
        f.file(f.ledger + '/original-journal.json', f.rawB);
        f.file(f.ledger + '/original-completed-journal.json', f.rawA);
        if (mode === 'changed') f.node(f.ledger + '/original-journal.json').bytes[0] ^= 1;
        if (mode === 'extra') f.file(f.ledger + '/unrequested', 'private');
        const at = effects(f).length,
            result = await thrown(f.create().inspect());
        if (mode === 'valid') assert.equal((result as any).returned, true);
        else assert.ok('error' in result, mode);
        assert.equal(effects(f).length, at);
        f.verifyKeep();
    }
});
