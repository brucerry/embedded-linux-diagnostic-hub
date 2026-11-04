import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { PRIVATE_SOURCE as LINUX_CI_SOURCE, LINUX_CI_LIMITS, LINUX_CI_ASSETS, LINUX_CI_METADATA,
    ciHash, ciJSON, validatePackageInput as validateLinuxCIInput, requireLinuxCISpace, accountLinuxCIUpload, verifyLinuxCIUploadReadback,
    privateLinuxCIRecord, inventoryLinuxCIFlat, createLinuxCINpmConfigs, verifyLinuxCINpmConfigs, packageEnvironment, packageArguments, gitQueryEnvironment,
    requireSafeGitQueries, observePackageChild, retireOwnedHandles, createCohortReceipt,
    completedCommandReceipt, validateCompletedCommand } from './lib/linux-private-integrated-ci.mjs';

// Import/help is inert. Real IO/Git queries are selected only by one of the explicit CI phases.
export function linuxCIPhase(args) {
    if (args.length !== 1 || !['admit', 'dependencies', 'pre-package', 'package', 'finalize', '--help'].includes(args[0])) throw Error('CI_PHASE');
    return args[0];
}
async function main(args) {
    const phase = linuxCIPhase(args);
    if (phase === '--help') { process.stdout.write('linux-private-integrated-ci.mjs admit|dependencies|pre-package|package|finalize\n'); return; }
    const input = validateLinuxCIInput({ event: process.env.GITHUB_EVENT_NAME,
        artifactOnly: process.env.DH_ARTIFACT_ONLY === 'true', repository: process.env.GITHUB_REPOSITORY,
        appSHA: process.env.DH_APP_SOURCE_SHA, workflowSHA: process.env.GITHUB_SHA,
        runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, buildId: process.env.DH_BUILD_ID,
        ref: process.env.GITHUB_REF, workflowFileSHA: process.env.DH_WORKFLOW_FILE_SHA });
    if (process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.platform !== 'linux' || process.arch !== 'x64' || process.versions.node !== '24.22.0' ||
        !process.getuid || !process.geteuid || process.getuid() <= 0 || process.getuid() !== process.geteuid()) throw Error('CI_RUNTIME');
    const fs = await import('node:fs/promises'), { constants } = await import('node:fs');
    const { execFileSync, spawn } = await import('node:child_process');
    const uid = process.getuid(), start = performance.now();
    const workspace = process.env.GITHUB_WORKSPACE;
    const home = process.env.HOME;
    if (!home || !path.isAbsolute(home) || path.normalize(home) !== home || !workspace ||
        !workspace.startsWith(home + '/') || !path.isAbsolute(workspace) || path.normalize(workspace) !== workspace ||
        await fs.realpath(workspace) !== workspace) throw Error('CI_ROOT');
    const app = path.join(workspace, 'application'), tooling = path.join(workspace, 'tooling'),
        parent = path.join(workspace, 'private-artifacts'), root = path.join(parent, input.buildId), upload = path.join(root, 'upload');
    const snap = s => {
        if (!Number.isSafeInteger(s.dev) || s.dev < 0 || !Number.isSafeInteger(s.ino) || s.ino <= 0 ||
            !Number.isSafeInteger(s.mode) || s.mode < 0 || s.mode > 0o177777 ||
            !Number.isSafeInteger(s.size) || s.size < 0 || s.uid !== uid || !Number.isSafeInteger(s.nlink) || s.nlink < 1 ||
            !Number.isFinite(s.mtimeMs) || !Number.isFinite(s.ctimeMs))
            throw Error('CI_FILE');
        return { dev: s.dev, ino: s.ino, mode: s.mode, size: s.size, uid: s.uid, nlink: s.nlink, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs };
    };
    const same = (a, b) => JSON.stringify(snap(a)) === JSON.stringify(snap(b));
    async function directory(p) {
        const s = await fs.lstat(p); snap(s);
        if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o7022) || await fs.realpath(p) !== p) throw Error('CI_DIRECTORY');
        return s;
    }
    async function absent(p) {
        try { await fs.lstat(p); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
        throw Error('CI_NOT_FRESH');
    }
    async function names(p, cap) {
        const before = await directory(p), handle = await fs.opendir(p), result = [],
            primary = { failed: false, error: undefined };
        try { for (;;) { const item = await handle.read(); if (!item) break;
            result.push(item.name); if (result.length > cap) throw Error('CI_COUNT'); } }
        catch (error) { primary.failed = true; primary.error = error; }
        finally { await retireOwnedHandles(primary, [handle]); }
        const after = await directory(p);
        if (!same(before, after)) throw Error('CI_CHANGED');
        return result.sort();
    }
    async function read(p, limit, copyTo = null, expected = null) {
        if (await fs.realpath(path.dirname(p)) !== path.dirname(p)) throw Error('CI_DIRECTORY');
        const before = await fs.lstat(p); snap(before);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o7022) || before.size > limit ||
            expected && !same(before, expected)) throw Error('CI_FILE');
        const fd = await fs.open(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), chunks = [],
            hash = createHash('sha256'); let destination = null, total = 0;
        const primary = { failed: false, error: undefined };
        try {
            if (!same(before, await fd.stat())) throw Error('CI_CHANGED');
            if (copyTo) destination = await fs.open(copyTo, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
                constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
            const buffer = Buffer.alloc(65536);
            for (;;) {
                const part = await fd.read(buffer, 0, Math.min(buffer.length, before.size - total + 1), total);
                if (!part.bytesRead) break; total += part.bytesRead;
                if (total > before.size) throw Error('CI_CHANGED');
                const bytes = buffer.subarray(0, part.bytesRead); hash.update(bytes);
                if (destination) {
                    let at = 0;
                    while (at < bytes.length) { const w = await destination.write(bytes, at, bytes.length - at);
                        if (w.bytesWritten < 1) throw Error('CI_WRITE'); at += w.bytesWritten; }
                }
                if (limit <= 1048576 && !copyTo) chunks.push(Buffer.from(bytes));
            }
            if (total !== before.size || !same(before, await fd.stat()) || !same(before, await fs.lstat(p))) throw Error('CI_CHANGED');
            if (destination) await destination.sync();
        } catch (error) { primary.failed = true; primary.error = error; }
        finally { await retireOwnedHandles(primary, [destination, fd]); }
        return { bytes: total, sha256: hash.digest('hex'), body: chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0), identity: before };
    }
    async function publish(name, bytes) {
        const cap = LINUX_CI_METADATA[name];
        if (!cap || !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > cap) throw Error('CI_METADATA_CAP');
        await directory(upload);
        const p = path.join(upload, name), fd = await fs.open(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
            constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
        const primary = { failed: false, error: undefined };
        try { await fd.writeFile(bytes); await fd.sync(); }
        catch (error) { primary.failed = true; primary.error = error; }
        finally { await retireOwnedHandles(primary, [fd]); }
        const observed = await read(p, cap);
        if (observed.bytes !== bytes.length || observed.sha256 !== ciHash(bytes)) throw Error('CI_WRITE');
    }
    async function publishControl(name, bytes) {
        if (!/^(?:dependencies|package)-(?:attempt|completed)\.json$/.test(name) && name !== 'cohort-receipt.json')
            throw Error('CI_METADATA_CAP');
        if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > LINUX_CI_LIMITS.receipt)
            throw Error('CI_METADATA_CAP');
        await directory(root);
        const p = path.join(root, name), handle = await fs.open(p,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW |
            constants.O_NONBLOCK, 0o600), primary = { failed: false, error: undefined };
        try { await handle.writeFile(bytes); await handle.sync(); }
        catch (error) { primary.failed = true; primary.error = error; }
        finally { await retireOwnedHandles(primary, [handle]); }
        const saved = await read(p, LINUX_CI_LIMITS.receipt);
        if (saved.sha256 !== ciHash(bytes)) throw Error('CI_CHANGED');
        return saved;
    }
    async function requireCommand(phase) {
        const value = JSON.parse((await read(path.join(root, phase + '-completed.json'),
            LINUX_CI_LIMITS.receipt)).body.toString());
        return validateCompletedCommand(value, input, phase);
    }
    const npmConfigIO = {
        async createEmpty(p) {
            await directory(root);
            const fd = await fs.open(p, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
                constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
            const primary = { failed: false, error: undefined };
            try { await fd.sync(); }
            catch (error) { primary.failed = true; primary.error = error; }
            finally { await retireOwnedHandles(primary, [fd]); }
            return true;
        },
        async inspectEmpty(p) {
            const observed = await read(p, 0), s = observed.identity;
            return { path: p, bytes: observed.bytes, sha256: observed.sha256,
                mode: s.mode & 0o777, uid: s.uid, nlink: s.nlink, dev: s.dev, ino: s.ino };
        }
    };
    async function space(which, bytes = 0) {
        const s = await fs.statfs(workspace, { bigint: true }); return requireLinuxCISpace(s.bavail * s.bsize, which, bytes);
    }
    const gitEnv = gitQueryEnvironment(process.env);
    const queryGit = (cwd, args) => {
        try {
            return { status: 0, stdout: execFileSync('/usr/bin/git',
                ['--no-pager', '--no-optional-locks', ...args],
                { cwd, env: gitEnv, maxBuffer: 65536, timeout: 10000,
                    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
        } catch (error) {
            if (Number.isInteger(error.status)) return { status: error.status,
                stdout: typeof error.stdout === 'string' ? error.stdout : '' };
            throw error;
        }
    };
    const git = (cwd, args) => {
        const result = queryGit(cwd, args);
        if (result.status !== 0) throw Error('CI_GIT_QUERY');
        return result.stdout;
    };
    for (const cwd of [app, tooling]) requireSafeGitQueries(args => queryGit(cwd, args));
    async function source() {
        await directory(app); await directory(tooling);
        const commit = git(app, ['rev-parse', 'HEAD']).trim(), tree = git(app, ['rev-parse', 'HEAD^{tree}']).trim(),
            workflowCommit = git(tooling, ['rev-parse', 'HEAD']).trim(), workflowTree = git(tooling, ['rev-parse', 'HEAD^{tree}']).trim();
        if (commit !== input.appSHA || tree !== LINUX_CI_SOURCE.tree || workflowCommit !== input.workflowSHA ||
            git(tooling, ['rev-parse', 'HEAD^']).trim() !== input.appSHA ||
            !/^[a-f0-9]{40}$/.test(workflowTree)) throw Error('CI_SOURCE');
        for (const n of ['scripts/linux-private-integrated-ci.mjs', 'scripts/lib/linux-private-integrated-ci.mjs',
            'scripts/lib/linux-artifact-ci.mjs', 'scripts/lib/linux-build-record.mjs', '.github/workflows/linux-portable.yml']) {
            const actual = await read(path.join(tooling, n), 65536), expected =
                Buffer.from(git(tooling, ['cat-file', 'blob', 'HEAD:' + n]));
            if (actual.sha256 !== ciHash(expected)) throw Error('CI_SOURCE');
        }
        const paths = git(app, ['ls-files', '-z']).split('\0'); if (paths.pop() !== '' || paths.length !== LINUX_CI_SOURCE.files) throw Error('CI_SOURCE');
        const files = []; let bytes = 0;
        for (const n of paths.sort()) {
            if (!n || path.posix.normalize(n) !== n || n.startsWith('/') || n.startsWith('../') || /[\\\x00-\x1f\x7f]/.test(n)) throw Error('CI_SOURCE');
            const observed = await read(path.join(app, n), 1048576); bytes += observed.bytes;
            files.push({ path: n, bytes: observed.bytes, mode: observed.identity.mode & 0o777, sha256: observed.sha256 });
        }
        const ordered = files.map(v => ({ path: v.path, bytes: v.bytes, mode: v.mode, sha256: v.sha256 }));
        // Same canonical sorted-key files-array digest as the accepted source packet.
        const canonical = JSON.stringify(ordered.map(v => ({ bytes: v.bytes, mode: v.mode, path: v.path, sha256: v.sha256 })));
        if (bytes !== LINUX_CI_SOURCE.bytes || ciHash(Buffer.from(canonical)) !== LINUX_CI_SOURCE.sha256) throw Error('CI_SOURCE');
        const pkg = JSON.parse((await read(path.join(app, 'package.json'), 65536)).body.toString());
        return { schema: 1, version: pkg.version, commit, tree, workflowCommit, workflowTree,
            sourceSHA256: LINUX_CI_SOURCE.sha256, files: ordered };
    }
    await directory(workspace);
    if (phase === 'admit') {
        const available = await space('dependencies'); await absent(parent);
        await fs.mkdir(parent, { mode: 0o700 }); await fs.mkdir(root, { mode: 0o700 }); await fs.mkdir(upload, { mode: 0o700 });
        for (const n of ['npm-cache', 'electron-cache', 'builder-cache', 'node-gyp-cache', 'cache', 'tmp']) await fs.mkdir(path.join(root, n), { mode: 0o700 });
        const npmConfigs = await createLinuxCINpmConfigs(root, uid, npmConfigIO);
        for (const n of ['release', 'dist', 'dist-electron', 'node_modules']) await absent(path.join(app, n));
        const observed = await source(), manifestBytes = ciJSON(observed);
        const lock = JSON.parse((await read(path.join(app, 'package-lock.json'), 1048576)).body.toString());
        for (const dependency of Object.values(lock.packages)) {
            if (dependency.resolved && !dependency.resolved.startsWith('https://registry.npmjs.org/'))
                throw Error('CI_REGISTRY');
        }
        await absent(path.join(app, '.npmrc'));
        const sourceRecord = { schema: 1, kind: 'private-linux-build-source', repository: input.repository,
            version: observed.version, commit: observed.commit, tree: observed.tree,
            sourceManifestSHA256: ciHash(manifestBytes), buildId: input.buildId };
        await publish('source-manifest.json', manifestBytes); await publish('private-source.json', ciJSON(sourceRecord));
        await publish('tooling-identity.json', ciJSON({ workflowCommit: observed.workflowCommit,
            workflowTree: observed.workflowTree, applicationCommit: observed.commit, node: process.versions,
            scriptSHA256: (await read(path.join(tooling, 'scripts/linux-private-integrated-ci.mjs'), 1048576)).sha256,
            helperSHA256: (await read(path.join(tooling, 'scripts/lib/linux-private-integrated-ci.mjs'), 1048576)).sha256,
            workflowSHA256: (await read(path.join(tooling, '.github/workflows/linux-portable.yml'), 1048576)).sha256 }));
        await publish('admission.json', ciJSON({ schema: 1, input, space: available, utc: new Date().toISOString(),
            appRoot: app, outputRoot: root, sourceSHA256: observed.sourceSHA256, sourceRecordSHA256: ciHash(ciJSON(sourceRecord)), npmConfigs }));
    } else {
        await directory(parent); await directory(root); await directory(upload);
        const admitted = JSON.parse((await read(path.join(upload, 'admission.json'), 8192)).body.toString());
        if (JSON.stringify(admitted.input) !== JSON.stringify(input) || admitted.appRoot !== app || admitted.outputRoot !== root ||
            admitted.sourceSHA256 !== LINUX_CI_SOURCE.sha256) throw Error('CI_ADMISSION');
        await verifyLinuxCINpmConfigs(root, uid, npmConfigIO, admitted.npmConfigs);
        const observed = await source(), manifestBytes = ciJSON(observed);
        if ((await read(path.join(upload, 'source-manifest.json'), 1048576)).sha256 !== ciHash(manifestBytes)) throw Error('CI_SOURCE');
        if (phase === 'dependencies' || phase === 'package') {
            if (phase === 'dependencies') await absent(path.join(app, 'node_modules'));
            else {
                const prepared = JSON.parse((await read(path.join(upload, 'pre-package.json'), 65536)).body.toString());
                if (prepared.applicationCommit !== observed.commit || prepared.space?.phase !== 'package')
                    throw Error('CI_ADMISSION');
            }
            if (phase === 'package') {
                await requireCommand('dependencies');
                for (const n of ['release', 'dist', 'dist-electron']) await absent(path.join(app, n));
            }
            const environment = packageEnvironment(process.env, process.execPath, workspace, root);
            const args = packageArguments(phase, process.execPath), npm = args[0];
            if (await fs.realpath(npm) !== npm || !(await fs.lstat(npm)).isFile()) throw Error('CI_RUNTIME');
            // Exclusive immutable attempt marker before launch. No retry/overwrite on any failure.
            await publishControl(phase + '-attempt.json', ciJSON({ schema: 1, phase, input,
                status: 'admitted-unfinished', noAutomaticRetry: true }));
            const child = spawn(process.execPath, args, { cwd: app, env: environment,
                shell: false, stdio: 'inherit' });
            const completion = await observePackageChild(child);
            if (completion.error || completion.code !== 0 || completion.signal !== null) {
                const error = new Error('CI_COMMAND', { cause: completion.error });
                error.completion = completion;
                throw error;
            }
            await publishControl(phase + '-completed.json', ciJSON(completedCommandReceipt(input, phase, completion)));
            process.stdout.write(JSON.stringify({ phase, status: 'command-completed-unqualified',
                childCloseObserved: true, descendantRetirementQualified: false, handoffAllowed: false }) + '\n');
        } else if (phase === 'pre-package') {
            await requireCommand('dependencies');
            const tools = {};
            for (const n of ['electron', 'electron-builder', 'app-builder-lib', 'typescript', 'esbuild', 'vite', 'tar']) {
                const value = await read(path.join(app, 'node_modules', n, 'package.json'), 65536);
                tools[n] = { version: JSON.parse(value.body.toString()).version, manifestSHA256: value.sha256 };
            }
            await publish('pre-package.json', ciJSON({ schema: 1, space: await space('package'), tools,
                applicationCommit: observed.commit, utc: new Date().toISOString() }));
        } else {
            await requireCommand('package');
            const prePackage = JSON.parse((await read(path.join(upload, 'pre-package.json'), 65536)).body.toString());
            if (prePackage.schema !== 1 || prePackage.applicationCommit !== observed.commit || prePackage.space?.phase !== 'package')
                throw Error('CI_ADMISSION');
            const flat = path.join(app, 'release/linux-unpacked'); await directory(flat);
            const inventory = await inventoryLinuxCIFlat(flat, {
                children: async (base, n) => names(path.join(base, n), 40000),
                inspect: async (base, n) => { const s = await fs.lstat(path.join(base, n)); snap(s);
                    if (s.isSymbolicLink() || (s.mode & 0o7022) || s.isFile() && s.nlink !== 1) throw Error('CI_PAYLOAD');
                    return { kind: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'unsupported',
                        bytes: s.size, mode: s.mode & 0o777, identity: s }; },
                hash: async (base, n, expected) => (await read(path.join(base, n), LINUX_CI_LIMITS.payload, null, expected.identity)).sha256 });
            const assets = {}, facts = [];
            for (const name of LINUX_CI_ASSETS) {
                const value = await read(path.join(app, 'release', name), LINUX_CI_LIMITS.asset);
                if (value.bytes < 1) throw Error('CI_ASSET_CAP'); assets[name] = value.sha256; facts.push({ name, ...value });
            }
            await space('copy', facts.reduce((n, v) => n + v.bytes, 0));
            // Use the existing selected application's planner; never construct its disk adapter/helper.
            const { planLinuxReviewEnvelope } = await import(pathToFileURL(path.join(app, 'scripts/lib/linux-setup-envelope.ts')).href);
            const plan = planLinuxReviewEnvelope({ platform: 'linux', arch: 'x64', uid, euid: uid, home: process.env.HOME,
                sourceRoot: flat, outputRoot: path.join(root, 'not-prepared'), archivePath: path.join(app, 'release/Diagnostic-Hub-linux-x64.tar.gz'),
                archive: { asset: 'Diagnostic-Hub-linux-x64.tar.gz', bytes: facts[1].bytes, sha256: facts[1].sha256 },
                layout: 'flat-linux-portable', version: observed.version, sourceCommit: observed.commit,
                files: inventory.files, inventorySHA256: inventory.inventorySHA256 });
            if (JSON.stringify(plan.directories) !== JSON.stringify(inventory.directories)) throw Error('CI_PAYLOAD');
            const sourceBytes = (await read(path.join(upload, 'private-source.json'), 65536)).body,
                privateSource = JSON.parse(sourceBytes.toString());
            if (privateSource.commit !== observed.commit || privateSource.tree !== observed.tree ||
                privateSource.version !== observed.version || privateSource.buildId !== input.buildId ||
                privateSource.sourceManifestSHA256 !== ciHash(manifestBytes) || ciHash(sourceBytes) !== admitted.sourceRecordSHA256)
                throw Error('CI_SOURCE');
            await publish('flat-inventory.json', ciJSON(inventory));
            await publish('diagnostic-hub-setup-payload.json', Buffer.from(plan.descriptor));
            await publish('linux-build-info.json', ciJSON(privateLinuxCIRecord(privateSource, assets, facts[1].bytes, sourceBytes)));
            for (const value of facts) {
                await read(path.join(app, 'release', value.name), LINUX_CI_LIMITS.asset, path.join(upload, value.name), value.identity);
                if ((await read(path.join(upload, value.name), LINUX_CI_LIMITS.asset)).sha256 !== value.sha256) throw Error('CI_CHANGED');
                await publish(value.name + '.sha256', Buffer.from(value.sha256 + '  ' + value.name + '\n'));
            }
            await publish('build-result.json', ciJSON({ schema: 1, status: 'private-artifacts-built-unqualified', input,
                applicationCommit: observed.commit, workflowCommit: observed.workflowCommit,
                validation: 'unperformed', descriptorPrepared: false, observerRun: false,
                appLaunched: false, installed: false, publishedRelease: false, handoffAllowed: false, nativeMutation: false,
                compiledSourceProven: false, utc: new Date().toISOString() }));
            const entries = [];
            for (const name of await names(upload, 14)) {
                const cap = LINUX_CI_ASSETS.includes(name) ? LINUX_CI_LIMITS.asset : LINUX_CI_METADATA[name];
                if (!cap) throw Error('CI_UPLOAD'); const v = await read(path.join(upload, name), cap);
                entries.push({ name, bytes: v.bytes, sha256: v.sha256 });
            }
            const accounting = accountLinuxCIUpload(entries, true), accountBytes = ciJSON({ schema: 1,
                ...accounting, accountingFileExcludedFromHashList: true });
            if (accounting.metadataBytes + accountBytes.length > LINUX_CI_LIMITS.metadata) throw Error('CI_METADATA_CAP');
            const retainedFiles = Object.freeze(accounting.files.map(file => Object.freeze({ ...file }))),
                expectedAccounting = Object.freeze({ bytes: accountBytes.length, sha256: ciHash(accountBytes) });
            await publish('upload-accounting.json', accountBytes);
            // No mode changes: all internal writers are closed. Re-read the exact cohort.
            // Trusted fresh namespace only; this is not a malicious same-owner race guarantee.
            const audited = [];
            for (const name of await names(upload, 14)) {
                const cap = LINUX_CI_ASSETS.includes(name) ? LINUX_CI_LIMITS.asset : LINUX_CI_METADATA[name];
                if (!cap) throw Error('CI_UPLOAD'); const v = await read(path.join(upload, name), cap);
                audited.push({ name, bytes: v.bytes, sha256: v.sha256 });
            }
            const final = verifyLinuxCIUploadReadback(retainedFiles, expectedAccounting, audited);
            const cohortReceipt = createCohortReceipt(input, final.files, expectedAccounting, inventory),
                receiptBytes = ciJSON(cohortReceipt);
            if (receiptBytes.length > LINUX_CI_LIMITS.receipt ||
                final.metadataBytes + receiptBytes.length > LINUX_CI_LIMITS.metadata) throw Error('CI_METADATA_CAP');
            const savedReceipt = await publishControl('cohort-receipt.json', receiptBytes);
            const summary = ciJSON({ status: 'upload-accounted-unqualified', receiptSHA256: savedReceipt.sha256,
                assetBytes: final.assetBytes,
                metadataBytes: final.metadataBytes, totalBytes: final.totalBytes, handoffAllowed: false });
            if (summary.length > 8192) throw Error('CI_METADATA_CAP'); process.stdout.write(summary);
        }
    }
    const summary = ciJSON({ phase, status: 'completed', elapsedMs: performance.now() - start, handoffAllowed: false });
    if (summary.length > 8192) throw Error('CI_METADATA_CAP'); process.stdout.write(summary);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    void main(process.argv.slice(2)).catch(error => {
        const reasons = new Set(['CI_PHASE', 'CI_INPUT', 'CI_RUNTIME', 'CI_ROOT', 'CI_FILE', 'CI_DIRECTORY',
            'CI_NOT_FRESH', 'CI_COUNT', 'CI_CHANGED', 'CI_WRITE', 'CI_METADATA_CAP', 'CI_SOURCE',
            'CI_ENV', 'CI_GIT_ENV', 'CI_GIT_CONFIG', 'CI_GIT_QUERY', 'CI_REGISTRY', 'CI_COMMAND', 'CI_CLOSE',
            'CI_NATIVE_IDENTITY', 'CI_RECEIPT', 'CI_ADMISSION', 'CI_PAYLOAD', 'CI_PAYLOAD_CAP', 'CI_ASSET_CAP', 'CI_UPLOAD', 'CI_SPACE', 'CI_NPM_CONFIG']);
        const code = reasons.has(error?.code) ? error.code : reasons.has(error?.message) ? error.message : 'CI_UNKNOWN';
        const errors = error instanceof AggregateError ? error.errors : [error];
        const diagnostics = errors.slice(0, 8).map(value => createHash('sha256').update(String(value?.message ?? value)).digest('hex'));
        process.stderr.write(JSON.stringify({ status: 'failed-unqualified', code, diagnostics,
            retirementProven: error?.retirementProven === false ? false : null, handoffAllowed: false }) + '\n');
        process.exitCode = 1;
    });
}
