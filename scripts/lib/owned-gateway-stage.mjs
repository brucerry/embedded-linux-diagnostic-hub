import assert from 'node:assert/strict';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readStableArtifactFile, WEB_ARCHIVE_LIMITS } from './web-archive-producer.mjs';
import { requireObservedClosure } from './owned-child.mjs';

const retained = new Set(); // Only uncertain IO/command owners; no forced cleanup or automatic retry.
function relative(value) {
    assert.ok(typeof value === 'string' && value && !/[\\:\x00-\x1f\x7f]/.test(value));
    assert.ok(value.split('/').every((part) => part && part !== '.' && part !== '..'));
}
export class OwnedGatewayStage {
    /** @type {string} */ sourceRoot;
    /** @type {string} */ directory;
    /** @type {string} */ token;
    #fs;
    #failure = null;
    #pending = new Map();
    #operation = null;
    #ordinal = 0;
    #sealed = false;
    #action = null;
    #directories = new Set();
    #initialized = false;
    #initializing = false;
    #plans = new Map();
    #roles = new Set();
    #completed = new Set();
    #namespace = 'not-attempted';
    constructor(filesystem, sourceRoot, leaf) {
        assert.ok(path.isAbsolute(sourceRoot));
        assert.match(leaf, /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
        this.#fs = filesystem;
        Object.defineProperties(this, {
            sourceRoot: { value: sourceRoot, enumerable: true },
            directory: { value: path.join(sourceRoot, 'validation', leaf), enumerable: true },
            token: { value: randomBytes(16).toString('hex'), enumerable: true },
        });
    }
    get stageDirectory() {
        return path.join(this.directory, 'stage');
    }
    get buildEntry() {
        return path.join(this.directory, 'build/main.cjs');
    }
    #admit() {
        assert.equal(this.#action, null, 'File IO still owns the stage.');
        assert.equal(this.#pending.size, 0, 'File handles remain unacknowledged.');
        assert.equal(this.#initialized, true, 'Gateway stage is not initialized.');
        assert.equal(this.#failure, null, 'Failed Gateway owner retains custody.');
        assert.equal(this.#sealed, false);
        assert.equal(this.#operation, null, 'Command still owns the stage.');
    }
    #retain() {
        if (
            this.#pending.size ||
            this.#operation ||
            this.#action ||
            this.#namespace === 'creation-requested'
        )
            retained.add(this);
        else retained.delete(this);
    }
    #fail(error) {
        this.#failure ??= error;
        this.#retain();
        return error;
    }
    snapshot() {
        return Object.freeze({
            token: this.token,
            failed: this.#failure !== null,
            sealed: this.#sealed,
            fileAction: this.#action ? { id: this.#action.id, kind: this.#action.kind } : null,
            pendingFiles: [...this.#pending.keys()],
            plannedCommands: [...this.#plans.keys()],
            command: this.#operation
                ? { id: this.#operation.id, role: this.#operation.role }
                : null,
            namespace: this.#namespace,
            workspace: 'retained-no-deletion',
            descendantRetirement: null,
        });
    }
    async initialize() {
        assert.equal(this.#initializing, false);
        assert.equal(this.#initialized, false);
        assert.equal(this.#failure, null);
        this.#initializing = true;
        try {
            const parent = path.dirname(this.directory);
            assert.equal(await this.#fs.realpath(this.sourceRoot), this.sourceRoot);
            assert.equal(await this.#fs.realpath(parent), parent);
            const stat = await this.#fs.lstat(parent);
            assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
            this.#namespace = 'creation-requested';
            await this.#fs.mkdir(this.directory); // Existing work is refused, never adopted.
            this.#namespace = 'acknowledged-new';
            this.#directories.add(this.directory);
            for (const name of ['stage', 'build', 'cache', 'config', 'artifacts'])
                await this.#mkdir(path.join(this.directory, name));
            await this.#write('config/user.npmrc', Buffer.alloc(0));
            await this.#write('config/global.npmrc', Buffer.alloc(0));
            this.#initialized = true;
            this.#initializing = false;
            return this;
        } catch (error) {
            this.#initializing = false;
            if (error?.code === 'EEXIST' && this.#namespace === 'creation-requested')
                this.#namespace = 'exists-refused';
            throw this.#fail(error);
        }
    }
    async #mkdir(directory) {
        if (this.#directories.has(directory)) return;
        assert.ok(directory.startsWith(this.directory + path.sep));
        const parent = path.dirname(directory);
        if (!this.#directories.has(parent)) await this.#mkdir(parent);
        assert.equal(await this.#fs.realpath(parent), parent);
        const stat = await this.#fs.lstat(parent);
        assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
        await this.#fs.mkdir(directory);
        this.#directories.add(directory);
        assert.equal(await this.#fs.realpath(directory), directory);
    }
    async #open(file, flags) {
        const id = ++this.#ordinal,
            row = { file, handle: null, state: 'opening' };
        this.#pending.set(id, row);
        retained.add(this);
        try {
            row.handle = await this.#fs.open(file, flags);
            row.state = 'open';
            return { id, handle: row.handle };
        } catch (error) {
            row.state = 'open-rejected-unknown';
            throw this.#fail(error);
        }
    }
    async #close(id, handle) {
        try {
            await handle.close();
            this.#pending.delete(id);
            this.#retain();
        } catch (error) {
            this.#pending.get(id).state = 'close-unacknowledged';
            throw this.#fail(error);
        }
    }
    async #write(name, bytes, maximum = WEB_ARCHIVE_LIMITS.member) {
        relative(name);
        assert.ok(
            Buffer.isBuffer(bytes) &&
                bytes.length <= maximum &&
                maximum <= WEB_ARCHIVE_LIMITS.archive,
        );
        const file = path.join(this.directory, name);
        await this.#mkdir(path.dirname(file));
        const parent = path.dirname(file);
        assert.equal(await this.#fs.realpath(parent), parent);
        const parentStat = await this.#fs.lstat(parent);
        assert.ok(parentStat.isDirectory() && !parentStat.isSymbolicLink());
        const { id, handle } = await this.#open(file, 'wx'),
            errors = [];
        try {
            await handle.writeFile(bytes);
            await handle.sync();
        } catch (error) {
            errors.push(error);
        }
        try {
            await this.#close(id, handle);
        } catch (error) {
            errors.push(error);
        }
        if (errors.length === 1) throw this.#fail(errors[0]);
        if (errors.length)
            throw this.#fail(
                new AggregateError(errors, 'Gateway write/close failed.', { cause: errors[0] }),
            );
    }
    async #read(name, maximum) {
        relative(name);
        const fs = {
            realpath: (file) => this.#fs.realpath(file),
            lstat: (file) => this.#fs.lstat(file),
            open: async (file, flags) => {
                const { id, handle } = await this.#open(file, flags);
                return {
                    read: (...args) => handle.read(...args),
                    stat: () => handle.stat(),
                    close: () => this.#close(id, handle),
                };
            },
        };
        try {
            return (await readStableArtifactFile(this.directory, name, maximum, fs)).bytes;
        } catch (error) {
            throw this.#fail(error);
        }
    }
    async #fileAction(kind, work) {
        this.#admit();
        assert.equal(this.#plans.size, 0, 'An issued command plan owns admission.');
        const id = ++this.#ordinal;
        this.#action = { id, kind };
        this.#retain();
        try {
            const value = await work();
            if (this.#failure) throw this.#failure;
            return value;
        } catch (error) {
            throw this.#fail(error);
        } finally {
            if (this.#action?.id === id && !this.#pending.size) this.#action = null;
            this.#retain();
        }
    }
    async putPayload(files) {
        return this.#fileAction('write-payload', async () => {
            for (const [name, bytes] of files) {
                relative(name);
                await this.#write('stage/' + name, bytes);
            }
        });
    }
    async readBuild() {
        return this.#fileAction('read-build', () =>
            this.#read('build/main.cjs', WEB_ARCHIVE_LIMITS.member),
        );
    }
    async collect(expectedFiles) {
        return this.#fileAction('inventory', async () => {
            assert.ok(Array.isArray(expectedFiles));
            const allowed = new Set(expectedFiles),
                directories = new Set();
            for (const file of allowed) {
                relative(file);
                const parts = file.split('/');
                parts.pop();
                while (parts.length) {
                    directories.add(parts.join('/'));
                    parts.pop();
                }
            }
            const files = new Map();
            let entries = 0,
                total = 0;
            try {
                const visit = async (directory, prefix) => {
                    assert.equal(await this.#fs.realpath(directory), directory);
                    const stat = await this.#fs.lstat(directory);
                    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
                    for (const item of await this.#fs.readdir(directory, { withFileTypes: true })) {
                        assert.ok(++entries <= WEB_ARCHIVE_LIMITS.entries);
                        relative(item.name);
                        const name = prefix ? prefix + '/' + item.name : item.name;
                        assert.ok(!item.isSymbolicLink());
                        if (item.isDirectory()) {
                            assert.ok(directories.has(name), 'Unexpected staged directory.');
                            await visit(path.join(directory, item.name), name);
                        } else {
                            assert.ok(
                                item.isFile() && allowed.has(name),
                                'Unexpected staged file.',
                            );
                            const bytes = await this.#read(
                                'stage/' + name,
                                WEB_ARCHIVE_LIMITS.member,
                            );
                            total += bytes.length;
                            assert.ok(total <= WEB_ARCHIVE_LIMITS.expanded);
                            files.set(name, bytes);
                        }
                    }
                };
                await visit(this.stageDirectory, '');
                return files;
            } catch (error) {
                throw this.#fail(error);
            }
        });
    }
    plan(role, toolchain) {
        this.#admit();
        assert.ok(['build', 'lock'].includes(role));
        assert.ok(!this.#roles.has(role), 'Gateway command replay refused.');
        if (role === 'lock') assert.ok(this.#completed.has('build'));
        this.#roles.add(role);
        if (role === 'build') assert.equal(toolchain.esbuildEntryFormat, 'node-script');
        const node = toolchain.runtime.executablePath;
        const command =
            role === 'build'
                ? [
                      node,
                      toolchain.esbuildEntryPath,
                      path.join(this.sourceRoot, 'gateway/main.ts'),
                      '--bundle',
                      '--platform=node',
                      '--format=cjs',
                      '--outfile=' + this.buildEntry,
                      '--external:ssh2',
                  ]
                : [
                      node,
                      toolchain.npmEntryPath,
                      'install',
                      '--package-lock-only',
                      '--offline',
                      '--ignore-scripts',
                      '--omit=optional',
                      '--no-audit',
                      '--no-fund',
                      '--global=false',
                      '--workspaces=false',
                      '--prefix=' + this.stageDirectory,
                      '--cache=' + path.join(this.directory, 'cache'),
                      '--userconfig=' + path.join(this.directory, 'config/user.npmrc'),
                      '--globalconfig=' + path.join(this.directory, 'config/global.npmrc'),
                  ];
        const plan = Object.freeze({
            owner: this.token,
            id: ++this.#ordinal,
            role,
            cwd: role === 'build' ? this.sourceRoot : this.stageDirectory,
            command: Object.freeze(command),
        });
        this.#plans.set(plan.id, plan);
        return plan;
    }
    async execute(plan, executor) {
        this.#admit();
        assert.equal(this.#plans.get(plan.id), plan, 'Unissued Gateway plan.');
        assert.equal(plan.owner, this.token);
        assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.command));
        this.#plans.delete(plan.id);
        this.#operation = plan;
        retained.add(this);
        try {
            const result = await executor(plan);
            assert.deepEqual(Object.keys(result).sort(), [
                'command',
                'cwd',
                'id',
                'lifecycle',
                'owner',
                'role',
            ]);
            for (const key of ['owner', 'id', 'role', 'cwd'])
                assert.equal(
                    result[key],
                    plan[key],
                    'Stale/foreign Gateway command acknowledgement.',
                );
            assert.deepEqual(result.command, plan.command);
            const row = result.lifecycle;
            assert.deepEqual(Object.keys(row).sort(), [
                'closeCode',
                'closeObserved',
                'closeSignal',
                'code',
                'elapsedMs',
                'error',
                'exitObserved',
                'killErrors',
                'pid',
                'signal',
                'spawnObserved',
                'terminationRequested',
                'timedOut',
            ]);
            for (const key of [
                'spawnObserved',
                'exitObserved',
                'closeObserved',
                'timedOut',
                'terminationRequested',
            ])
                assert.equal(typeof row[key], 'boolean');
            // Known direct closure can retire a failed command; unknown results retain the owner.
            const closed =
                Number.isSafeInteger(row?.pid) &&
                row.pid > 0 &&
                row.spawnObserved === true &&
                row.exitObserved === true &&
                row.closeObserved === true &&
                row.code === row.closeCode &&
                row.signal === row.closeSignal &&
                ((Number.isSafeInteger(row.code) && row.code >= 0 && row.signal === null) ||
                    (row.code === null && typeof row.signal === 'string'));
            if (closed) this.#operation = null;
            requireObservedClosure(row);
            assert.equal(row.code, 0);
            assert.equal(row.terminationRequested, false);
            assert.deepEqual(row.killErrors, []);
            assert.ok(Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0);
            this.#operation = null;
            if (this.#failure) throw this.#failure;
            this.#completed.add(plan.role);
            retained.delete(this);
            return JSON.parse(JSON.stringify(result));
        } catch (error) {
            throw this.#fail(error);
        }
    }
    async publish(name, bytes) {
        return this.#fileAction('publish', async () => {
            relative(name);
            assert.ok(!name.includes('/'));
            await this.#write('artifacts/' + name, bytes, WEB_ARCHIVE_LIMITS.archive);
            return this.#read('artifacts/' + name, WEB_ARCHIVE_LIMITS.archive);
        });
    }
    assertQuiescent() {
        this.#admit();
        assert.equal(this.#pending.size, 0);
        assert.equal(this.#plans.size, 0);
    }
    seal() {
        this.assertQuiescent();
        this.#sealed = true;
        retained.delete(this);
        return this.snapshot();
    }
    fail(error) {
        this.#fail(error);
    }
}
