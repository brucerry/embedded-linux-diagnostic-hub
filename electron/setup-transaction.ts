import { physicalFS } from './physical-fs';
import {
    unlinkOwnedFile,
    removeOwnedDirectory,
    moveOwnedDirectory,
    copyOwnedFile,
    writeOwnedFile,
    ensurePlainDirectory,
    assertPlainAncestors,
} from './setup-paths';
import { createHash, randomUUID } from 'node:crypto';
const { lstat, open, readFile, readdir, realpath, statfs } = physicalFS.promises;
import path from 'node:path';
import {
    INSTALLATION_MANIFEST,
    INSTALLATION_RECORD,
    INSTALLATION_PRODUCT,
    MAX_INSTALLATION_MANIFEST_BYTES,
    validateInstallationManifest,
    validateInstallationRecord,
    installationActions,
    type InstallationManifest,
    type InstallationRecord,
} from '../shared/installation';
import {
    atomicSetupJSON,
    boundedSetupJSON,
    maintenancePaths,
    SETUP_OWNER,
    SETUP_PAYLOAD,
    SETUP_UNINSTALLER,
} from './installation-maintenance';

export interface SetupOptions {
    startMenu: boolean;
    desktop: boolean;
    launch: boolean;
}
export interface SetupIntegration {
    kind: 'shortcut' | 'registry';
    path: string;
    sha256?: string;
    values?: Record<string, string>;
}
interface Ownership {
    transactionId?: string;
    schemaVersion: 1;
    product: string;
    installationId: string;
    root: string;
    options: SetupOptions;
    integrations: SetupIntegration[];
}
interface Owned {
    record: InstallationRecord;
    manifest: InstallationManifest;
    owner: Ownership;
    digest: string;
}
interface Journal {
    schemaVersion: 1;
    product: string;
    transactionId: string;
    installationId: string;
    root: string;
    candidateDigest: string;
    candidateVersion: string;
    candidateActivatedAt?: number;
    operation?: 'install' | 'remove';
    removalSnapshotSHA256?: string;
    cleanupSHA256?: string;
    oldDigest: string | null;
    phase:
        | 'copying'
        | 'prepared'
        | 'old-retained'
        | 'candidate-active'
        | 'rolling-back'
        | 'candidate-confirmed'
        | 'remove-prepared'
        | 'remove-retained'
        | 'remove-payload'
        | 'remove-integrations'
        | 'remove-complete';
}
interface CleanupLedger {
    schemaVersion: 1;
    product: string;
    transactionId: string;
    installationId: string;
    root: string;
    mode: 'rollback' | 'finalize';
    slot: 'stage' | 'previous';
    owned: Owned | null;
}
export interface SetupContext {
    sourceRoot: string;
    home: string;
    appData: string;
    version: string;
    platform: string;
    arch: string;
    busy(root: string): Promise<boolean>;
    ownerAlive(owner: { pid: number; executable: string; createdAt: string }): Promise<boolean>;
    processIdentity(): Promise<{ pid: number; executable: string; createdAt: string }>;
    integrate(
        root: string,
        id: string,
        version: string,
        options: SetupOptions,
        previous: SetupIntegration[],
        save: (records: SetupIntegration[]) => Promise<void>,
    ): Promise<SetupIntegration[]>;
    validateIntegrations(root: string, id: string, records: SetupIntegration[]): void;
    removeIntegrations(root: string, id: string, records: SetupIntegration[]): Promise<void>;
    launch(root: string): Promise<void>;
    successorObserved(
        root: string,
        expected: { pid: number; creationTimeMs: number; profile: string },
        version: string,
    ): Promise<boolean>;
    /** Unit fixture injection only; the production worker exposes no phase/fault control. */
    onPhase?(phase: Journal['phase']): Promise<void>;
    /** Test-only post-deletion injection; never exposed by the native worker. */
    onDelete?(event: {
        operation: 'rollback' | 'finalize' | 'remove';
        relativePath: string;
        kind: 'file' | 'directory';
    }): Promise<void>;
}
export interface SetupProbe {
    root: string;
    state: 'new' | 'owned' | 'recovery';
    installedVersion: string | null;
    candidateVersion: string;
    actions: string[];
    profile: string;
    reviewToken: string;
    options: SetupOptions;
    needsRepair: boolean;
}
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const same = (a: string, b: string) =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (parent: string, child: string) => {
    const rel = path.relative(parent, child);
    return rel === '' || (!path.isAbsolute(rel) && !rel.split(path.sep).includes('..'));
};
const exists = async (file: string) => {
    try {
        await lstat(file);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
};
function options(value: SetupOptions): SetupOptions {
    if (
        !value ||
        Object.keys(value).some((key) => !['startMenu', 'desktop', 'launch'].includes(key)) ||
        Object.values(value).length !== 3 ||
        Object.values(value).some((flag) => typeof flag !== 'boolean')
    )
        throw Error('Invalid setup choices.');
    return { ...value };
}
async function regular(file: string) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw Error('Payload paths must be regular, unlinked files.');
    return stat;
}
async function plainDirectory(directory: string) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw Error('Unsafe installation directory alias.');
}
export class SetupTransaction {
    constructor(private context: SetupContext) {}
    private async requireInactive(...roots: string[]) {
        for (const root of roots)
            if (await this.context.busy(root))
                throw Error(
                    'Close the app in every affected transaction slot before maintenance; no process will be terminated.',
                );
    }
    private async destination(input: string) {
        if (this.context.platform !== 'win32' || this.context.arch !== 'x64')
            throw Error('Guided Windows setup requires Windows x64.');
        if (
            typeof input !== 'string' ||
            !path.isAbsolute(input) ||
            input.length > 240 ||
            /[\x00-\x1f]/.test(input) ||
            input.startsWith('\\\\')
        )
            throw Error('Choose a short absolute local installation folder.');
        const root = path.resolve(input),
            home = await realpath(this.context.home);
        if (
            !inside(home, root) ||
            same(home, root) ||
            path.basename(root).startsWith('.DiagnosticHub-')
        )
            throw Error('Choose an ordinary folder within your user profile.');
        if (inside(root, this.context.sourceRoot) || inside(this.context.sourceRoot, root))
            throw Error('The setup payload and selected destination must be separate.');
        const profileBase = path.join(this.context.appData, 'DiagnosticHub', 'profiles');
        if (inside(root, profileBase) || inside(profileBase, root))
            throw Error('Application files must remain separate from settings and reports.');
        let cursor = root;
        while (inside(home, cursor)) {
            try {
                const stat = await lstat(cursor);
                if (!stat.isDirectory() || stat.isSymbolicLink())
                    throw Error(
                        'Installation locations must not contain aliases or non-directories.',
                    );
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            if (same(cursor, home)) break;
            cursor = path.dirname(cursor);
        }
        return root;
    }
    private async payload() {
        const manifest = validateInstallationManifest(
            await boundedSetupJSON(
                path.join(this.context.sourceRoot, SETUP_PAYLOAD),
                MAX_INSTALLATION_MANIFEST_BYTES,
            ),
        );
        if (
            manifest.platform !== 'win32' ||
            manifest.arch !== 'x64' ||
            manifest.layout !== 'windows-nsis' ||
            manifest.version !== this.context.version
        )
            throw Error('The setup package does not match its native version/platform.');
        if (
            manifest.files.some((file) =>
                [
                    INSTALLATION_RECORD,
                    INSTALLATION_MANIFEST,
                    SETUP_OWNER,
                    SETUP_PAYLOAD,
                    SETUP_UNINSTALLER,
                ].includes(file.path),
            )
        )
            throw Error('The source payload includes reserved setup metadata.');
        return manifest;
    }
    private async owned(root: string): Promise<Owned> {
        await plainDirectory(root);
        const record = validateInstallationRecord(
            await boundedSetupJSON(path.join(root, INSTALLATION_RECORD)),
        );
        await boundedSetupJSON(
            path.join(root, INSTALLATION_MANIFEST),
            MAX_INSTALLATION_MANIFEST_BYTES,
        );
        const manifestBytes = await readFile(path.join(root, INSTALLATION_MANIFEST));
        if (
            manifestBytes.length > MAX_INSTALLATION_MANIFEST_BYTES ||
            hash(manifestBytes) !== record.manifestSHA256
        )
            throw Error(
                'Existing install identity is incomplete or changed; no automatic replacement.',
            );
        const manifest = validateInstallationManifest(
            await boundedSetupJSON(
                path.join(root, INSTALLATION_MANIFEST),
                MAX_INSTALLATION_MANIFEST_BYTES,
            ),
        );
        if (
            manifest.layout !== 'windows-nsis' ||
            manifest.platform !== 'win32' ||
            manifest.arch !== 'x64' ||
            record.profile !== 'dedicated'
        )
            throw Error('This setup cannot maintain that installation layout.');
        const owner = (await boundedSetupJSON(path.join(root, SETUP_OWNER))) as Ownership;
        if (
            owner.schemaVersion !== 1 ||
            owner.product !== INSTALLATION_PRODUCT ||
            owner.installationId !== record.installationId ||
            !same(owner.root, root) ||
            !Array.isArray(owner.integrations) ||
            owner.integrations.length > 4
        )
            throw Error('Existing setup ownership is invalid; preserve the folder.');
        options(owner.options);
        for (const integration of owner.integrations)
            if (
                !integration ||
                !['shortcut', 'registry'].includes(integration.kind) ||
                typeof integration.path !== 'string' ||
                integration.path.length > 4096
            )
                throw Error('Invalid owned integration.');
        return { record, manifest, owner, digest: record.manifestSHA256 };
    }
    private async journal(root: string): Promise<Journal | null> {
        const files = maintenancePaths(root);
        if (await exists(files.work)) await plainDirectory(files.work);
        if (!(await exists(files.journal))) return null;
        const journal = (await boundedSetupJSON(files.journal)) as Journal;
        if (
            journal.schemaVersion !== 1 ||
            journal.product !== INSTALLATION_PRODUCT ||
            !same(journal.root, root) ||
            !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
                journal.transactionId,
            ) ||
            !/^[a-f0-9-]{36}$/.test(journal.installationId) ||
            !/^[a-f0-9]{64}$/.test(journal.candidateDigest) ||
            !(journal.oldDigest === null || /^[a-f0-9]{64}$/.test(journal.oldDigest)) ||
            !(journal.operation === 'remove'
                ? [
                      'remove-prepared',
                      'remove-retained',
                      'remove-payload',
                      'remove-integrations',
                      'remove-complete',
                  ].includes(journal.phase) &&
                  /^[a-f0-9]{64}$/.test(journal.removalSnapshotSHA256 ?? '') &&
                  journal.oldDigest === journal.candidateDigest
                : (journal.operation === undefined || journal.operation === 'install') &&
                  [
                      'copying',
                      'prepared',
                      'old-retained',
                      'candidate-active',
                      'rolling-back',
                      'candidate-confirmed',
                  ].includes(journal.phase) &&
                  (!['rolling-back', 'candidate-confirmed'].includes(journal.phase) ||
                      /^[a-f0-9]{64}$/.test(journal.cleanupSHA256 ?? '')))
        )
            throw Error('Recovery state is invalid; no folders will be moved or removed.');
        return journal;
    }
    private places(root: string, id: string) {
        const base = maintenancePaths(root);
        return {
            ...base,
            stage: path.join(base.work, 'stage-' + id),
            previous: path.join(base.work, 'previous-' + id),
            removalSnapshot: path.join(base.work, 'removal-' + id + '.json'),
            cleanup: path.join(base.work, 'cleanup-' + id + '.json'),
        };
    }
    async probe(input: string): Promise<SetupProbe> {
        const root = await this.destination(input),
            candidate = await this.payload(),
            journal = await this.journal(root);
        if (journal?.operation === 'remove') {
            const snapshot = await this.removalSnapshot(root, journal);
            if (await exists(root)) {
                if (
                    journal.phase !== 'remove-prepared' ||
                    (await exists(this.places(root, journal.transactionId).previous))
                )
                    throw Error(
                        'An unexpected folder occupies the removal destination; preserve it.',
                    );
                const current = await this.owned(root);
                if (
                    current.digest !== journal.candidateDigest ||
                    current.record.installationId !== journal.installationId
                )
                    throw Error('Removal destination identity changed.');
            }
            return {
                root,
                state: 'recovery',
                installedVersion: snapshot.manifest.version,
                candidateVersion: candidate.version,
                actions: ['finishremove'],
                profile: path.join(
                    this.context.appData,
                    'DiagnosticHub',
                    'profiles',
                    journal.installationId,
                ),
                reviewToken: hash(JSON.stringify({ root, journal })),
                options: snapshot.owner.options,
                needsRepair: false,
            };
        }
        if (journal && ['rolling-back', 'candidate-confirmed'].includes(journal.phase))
            await this.cleanupLedger(root, journal);
        let installed: Owned | null = null;
        if (await exists(root)) {
            if ((await readdir(root)).length) {
                const identityFiles = await Promise.all(
                    [INSTALLATION_RECORD, INSTALLATION_MANIFEST, SETUP_OWNER].map((name) =>
                        exists(path.join(root, name)),
                    ),
                );
                if (!identityFiles.some(Boolean))
                    throw Error(
                        'This folder contains files but is not a recognized Diagnostic Hub installation. Choose an empty folder or an existing Diagnostic Hub installation managed by setup. No files were changed.',
                    );
                if (!identityFiles.every(Boolean))
                    throw Error(
                        'This installation has incomplete setup information. Choose another empty folder or use the matching setup to recover it. No files were changed.',
                    );
                installed = await this.owned(root);
            }
        }
        const initialComplete =
            journal?.phase === 'candidate-active' &&
            journal.oldDigest === null &&
            installed?.digest === journal.candidateDigest;
        const state = journal && !initialComplete ? 'recovery' : installed ? 'owned' : 'new';
        const entryPresent = Boolean(
            installed && (await exists(path.join(root, installed.manifest.entryPoint))),
        );
        const actions =
            journal && !initialComplete
                ? journal.phase === 'candidate-confirmed'
                    ? ['launch', 'finalize']
                    : journal.phase === 'rolling-back'
                      ? ['rollback']
                      : [
                            'rollback',
                            ...(installed && journal.phase === 'candidate-active'
                                ? ['launch', 'finalize']
                                : []),
                        ]
                : installationActions(
                      installed?.manifest.version ?? null,
                      candidate.version,
                  ).filter((action) => action !== 'launch' || entryPresent);
        const reviewToken = hash(
            JSON.stringify({
                root,
                digest: installed?.digest ?? null,
                id: installed?.record.installationId ?? null,
                candidate: hash(JSON.stringify(candidate)),
                journal,
            }),
        );
        return {
            root,
            state,
            installedVersion: installed?.manifest.version ?? null,
            candidateVersion: candidate.version,
            actions,
            profile: path.join(
                this.context.appData,
                'DiagnosticHub',
                'profiles',
                installed?.record.installationId ?? journal?.installationId ?? '(new installation)',
            ),
            reviewToken,
            options: installed?.owner.options ?? { startMenu: true, desktop: false, launch: false },
            needsRepair: Boolean(
                installed && !(await exists(path.join(root, installed.manifest.entryPoint))),
            ),
        };
    }
    private async acquire(root: string) {
        const files = maintenancePaths(root);
        await ensurePlainDirectory(path.dirname(root));
        if (await exists(files.work)) {
            const stat = await lstat(files.work);
            if (!stat.isDirectory() || stat.isSymbolicLink())
                throw Error('Unsafe maintenance location.');
        }
        await ensurePlainDirectory(files.work);
        if (await exists(files.lock)) {
            const old = (await boundedSetupJSON(files.lock)) as {
                product: string;
                root: string;
                pid: number;
                executable: string;
                createdAt: string;
            };
            if (
                old.product !== INSTALLATION_PRODUCT ||
                !same(old.root, root) ||
                !Number.isInteger(old.pid) ||
                old.pid < 1 ||
                typeof old.executable !== 'string' ||
                typeof old.createdAt !== 'string'
            )
                throw Error('Invalid maintenance owner; preserve its state.');
            if (await this.context.ownerAlive(old))
                throw Error('Another verified setup is using this location.');
            await unlinkOwnedFile(files.lock);
        }
        await assertPlainAncestors(files.lock);
        const handle = await open(files.lock, 'wx', 0o600);
        const identity = await this.context.processIdentity();
        const token = randomUUID();
        await handle.writeFile(
            JSON.stringify({ product: INSTALLATION_PRODUCT, root, token, ...identity }),
        );
        await handle.sync();
        await handle.close();
        return async () => {
            const current = (await boundedSetupJSON(files.lock)) as { token: string };
            if (current.token !== token) throw Error('Maintenance ownership changed.');
            await unlinkOwnedFile(files.lock);
        };
    }
    private async inventoryKnown(
        root: string,
        manifest: InstallationManifest,
        extra: string[] = [],
    ) {
        await plainDirectory(root);
        const allowed = new Set([
            ...manifest.files.map((file) => file.path),
            INSTALLATION_RECORD,
            INSTALLATION_MANIFEST,
            SETUP_OWNER,
            ...extra,
        ]);
        const allowedDirs = new Set<string>();
        for (const file of allowed) {
            let parent = path.posix.dirname(file);
            while (parent !== '.') {
                allowedDirs.add(parent);
                parent = path.posix.dirname(parent);
            }
        }
        let count = 0,
            bytes = 0;
        const visit = async (directory: string) => {
            for (const name of await readdir(directory)) {
                const file = path.join(directory, name),
                    stat = await lstat(file);
                if (stat.isSymbolicLink()) throw Error('Installation payload aliases are unsafe.');
                if (stat.isDirectory()) {
                    if (!allowedDirs.has(path.relative(root, file).split(path.sep).join('/')))
                        throw Error('The app folder contains an unowned directory.');
                    await visit(file);
                } else {
                    if (
                        !stat.isFile() ||
                        stat.nlink !== 1 ||
                        !allowed.has(path.relative(root, file).split(path.sep).join('/'))
                    )
                        throw Error(
                            'The app folder contains unowned content; nothing will remove or replace it.',
                        );
                    count++;
                    bytes += stat.size;
                    if (count > 20010 || bytes > 2 * 1024 ** 3)
                        throw Error('Installation inventory exceeds its safety bounds.');
                }
            }
        };
        await visit(root);
    }
    private async verify(root: string, manifest: InstallationManifest) {
        for (const file of manifest.files) {
            if (file.kind !== 'file') throw Error('Windows payload links are unsupported.');
            const filename = path.join(root, ...file.path.split('/')),
                stat = await regular(filename);
            if (stat.size !== file.bytes || hash(await readFile(filename)) !== file.sha256)
                throw Error('Package bytes failed verification: ' + file.path);
        }
    }
    private async removeTree(
        root: string,
        manifest: InstallationManifest,
        operation: 'rollback' | 'finalize' | 'remove',
    ) {
        if (!(await exists(root))) return;
        await this.inventoryKnown(root, manifest);
        const names = [
            ...new Set([
                ...manifest.files.map((file) => file.path),
                SETUP_OWNER,
                INSTALLATION_RECORD,
                INSTALLATION_MANIFEST,
            ]),
        ];
        const directories = new Set<string>();
        for (const name of names) {
            let parent = path.posix.dirname(name);
            while (parent !== '.') {
                directories.add(parent);
                parent = path.posix.dirname(parent);
            }
        }
        for (const name of names) {
            await plainDirectory(root);
            const parts = name.split('/');
            for (let length = 1; length < parts.length; length++) {
                const parent = path.join(root, ...parts.slice(0, length));
                if (await exists(parent)) await plainDirectory(parent);
            }
            const filename = path.join(root, ...parts);
            if (await exists(filename)) {
                await regular(filename);
                await this.requireInactive(root);
                await unlinkOwnedFile(filename);
                await this.context.onDelete?.({ operation, relativePath: name, kind: 'file' });
            }
        }
        // Paths come only from the validated manifest; never discover/recurse into new content.
        const ordered = [...directories].sort(
            (a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b),
        );
        for (const name of ordered) {
            const directory = path.join(root, ...name.split('/'));
            if (await exists(directory)) {
                await plainDirectory(directory);
                await this.requireInactive(root);
                await removeOwnedDirectory(directory);
                await this.context.onDelete?.({ operation, relativePath: name, kind: 'directory' });
            }
        }
        await plainDirectory(root);
        await this.requireInactive(root);
        await removeOwnedDirectory(root);
        await this.context.onDelete?.({ operation, relativePath: '.', kind: 'directory' });
    }
    private validateSnapshot(
        value: Owned,
        root: string,
        id: string,
        digest: string,
        version?: string,
    ): Owned {
        const record = validateInstallationRecord(value?.record),
            manifest = validateInstallationManifest(value?.manifest),
            owner = value?.owner;
        if (
            value.digest !== digest ||
            record.manifestSHA256 !== digest ||
            record.installationId !== id ||
            record.profile !== 'dedicated' ||
            (version !== undefined && manifest.version !== version) ||
            manifest.platform !== 'win32' ||
            manifest.arch !== 'x64' ||
            manifest.layout !== 'windows-nsis' ||
            owner?.schemaVersion !== 1 ||
            owner.product !== INSTALLATION_PRODUCT ||
            owner.installationId !== id ||
            !same(owner.root, root) ||
            !Array.isArray(owner.integrations) ||
            owner.integrations.length > 4
        )
            throw Error('Cleanup snapshot identity is invalid.');
        options(owner.options);
        return { record, manifest, owner, digest };
    }
    private async prepareCleanup(
        root: string,
        journal: Journal,
        mode: 'rollback' | 'finalize',
        owned: Owned | null,
    ) {
        const files = this.places(root, journal.transactionId);
        const ledger: CleanupLedger = {
            schemaVersion: 1,
            product: INSTALLATION_PRODUCT,
            transactionId: journal.transactionId,
            installationId: journal.installationId,
            root,
            mode,
            slot: mode === 'rollback' ? 'stage' : 'previous',
            owned,
        };
        const bytes = Buffer.from(JSON.stringify(ledger, null, 2));
        if (bytes.length > MAX_INSTALLATION_MANIFEST_BYTES + 65536)
            throw Error('Cleanup ledger exceeds its bound.');
        if (await exists(files.cleanup)) {
            await regular(files.cleanup);
            await boundedSetupJSON(files.cleanup, MAX_INSTALLATION_MANIFEST_BYTES + 65536);
            if (hash(await readFile(files.cleanup)) !== hash(bytes))
                throw Error('An unexpected cleanup ledger already exists. Preserve it.');
        } else await atomicSetupJSON(files.cleanup, ledger);
        journal.cleanupSHA256 = hash(bytes);
        await this.savePhase(
            files,
            journal,
            mode === 'rollback' ? 'rolling-back' : 'candidate-confirmed',
        );
        return ledger;
    }
    private async cleanupLedger(root: string, journal: Journal): Promise<CleanupLedger> {
        const file = this.places(root, journal.transactionId).cleanup;
        await regular(file);
        const value = (await boundedSetupJSON(
            file,
            MAX_INSTALLATION_MANIFEST_BYTES + 65536,
        )) as CleanupLedger;
        if (
            hash(await readFile(file)) !== journal.cleanupSHA256 ||
            value.schemaVersion !== 1 ||
            value.product !== INSTALLATION_PRODUCT ||
            value.transactionId !== journal.transactionId ||
            value.installationId !== journal.installationId ||
            !same(value.root, root) ||
            value.mode !== (journal.phase === 'rolling-back' ? 'rollback' : 'finalize') ||
            value.slot !== (value.mode === 'rollback' ? 'stage' : 'previous')
        )
            throw Error('Cleanup ledger identity differs; preserve all remaining artifacts.');
        const digest = value.mode === 'rollback' ? journal.candidateDigest : journal.oldDigest;
        if (value.owned !== null) {
            if (digest === null) throw Error('Unexpected cleanup slot ownership.');
            value.owned = this.validateSnapshot(
                value.owned,
                root,
                journal.installationId,
                digest,
                value.mode === 'rollback' ? journal.candidateVersion : undefined,
            );
            if (
                value.mode === 'rollback' &&
                value.owned.owner.transactionId !== journal.transactionId
            )
                throw Error('Rollback cleanup transaction identity differs.');
        } else if (value.mode === 'finalize' && digest !== null)
            throw Error('A retained previous payload requires a cleanup ledger.');
        return value;
    }
    private async completeCleanup(root: string, journal: Journal) {
        const files = this.places(root, journal.transactionId);
        // Journal unlink commits completion. Any later orphaned ledger is bounded and harmless.
        await unlinkOwnedFile(files.journal);
        if (await exists(files.ack)) await unlinkOwnedFile(files.ack);
        await unlinkOwnedFile(files.cleanup);
    }
    private async savePhase(
        files: ReturnType<SetupTransaction['places']>,
        journal: Journal,
        phase: Journal['phase'],
    ) {
        journal.phase = phase;
        if (phase === 'candidate-active') journal.candidateActivatedAt = Date.now();
        await atomicSetupJSON(files.journal, journal);
        await this.context.onPhase?.(phase);
    }
    private async discardCompletedInitial(root: string) {
        const journal = await this.journal(root);
        if (!journal) return;
        const current = await this.owned(root);
        if (
            journal.phase !== 'candidate-active' ||
            journal.oldDigest !== null ||
            current.digest !== journal.candidateDigest ||
            current.record.installationId !== journal.installationId
        )
            throw Error('Confirm or recover the previous transaction first.');
        const files = this.places(root, journal.transactionId);
        if ((await exists(files.previous)) || (await exists(files.stage)))
            throw Error('Unexpected initial recovery material; preserve it.');
        await unlinkOwnedFile(files.journal);
        if (await exists(files.ack)) await unlinkOwnedFile(files.ack);
    }
    async install(
        input: string,
        action: 'install' | 'repair' | 'update',
        choices: SetupOptions,
        token: string,
        consent: boolean,
        uninstaller: string,
    ) {
        if (consent !== true) throw Error('Review and confirm the selected setup operation.');
        const probe = await this.probe(input);
        if (probe.reviewToken !== token || !probe.actions.includes(action))
            throw Error(
                'Installation state changed or that maintenance action is unavailable. Review again.',
            );
        const root = probe.root,
            selected = options(choices),
            candidate = await this.payload();
        const release = await this.acquire(root);
        let journal: Journal | null = null;
        try {
            if (await this.context.busy(root))
                throw Error('Close this installation before setup; no process will be terminated.');
            if ((await this.probe(root)).reviewToken !== token)
                throw Error(
                    'Reviewed installation changed while acquiring maintenance. Review again.',
                );
            await this.discardCompletedInitial(root);
            const current = probe.state === 'owned' ? await this.owned(root) : null;
            if (current) await this.inventoryKnown(root, current.manifest);
            const free = await statfs(path.dirname(root));
            const requested = candidate.files.reduce(
                (total, item) => total + (item.kind === 'file' ? item.bytes : 0),
                0,
            );
            if (Number(free.bavail) * Number(free.bsize) < requested * 3 + 64 * 1024 ** 2)
                throw Error('Insufficient space for verified staging and recovery.');
            await this.verify(this.context.sourceRoot, candidate);
            const id = current?.record.installationId ?? randomUUID(),
                transactionId = randomUUID(),
                files = this.places(root, transactionId);
            const sourceBytes = await readFile(path.join(this.context.sourceRoot, SETUP_PAYLOAD));
            const uninstallStat = await regular(uninstaller);
            if (
                !same(path.dirname(uninstaller), path.dirname(this.context.sourceRoot)) ||
                path.basename(uninstaller) !== SETUP_UNINSTALLER ||
                uninstallStat.size > 1024 ** 3
            )
                throw Error('Uninstaller must be the setup-owned embedded payload.');
            const manifest = validateInstallationManifest({
                ...candidate,
                files: [
                    ...candidate.files,
                    {
                        kind: 'file',
                        path: SETUP_PAYLOAD,
                        bytes: sourceBytes.length,
                        sha256: hash(sourceBytes),
                    },
                    {
                        kind: 'file',
                        path: SETUP_UNINSTALLER,
                        bytes: uninstallStat.size,
                        sha256: hash(await readFile(uninstaller)),
                    },
                ],
            });
            const manifestBytes = JSON.stringify(manifest),
                record = {
                    schemaVersion: 1,
                    product: INSTALLATION_PRODUCT,
                    installationId: id,
                    manifestSHA256: hash(manifestBytes),
                    profile: 'dedicated' as const,
                };
            const owner: Ownership = {
                transactionId,
                schemaVersion: 1,
                product: INSTALLATION_PRODUCT,
                installationId: id,
                root,
                options: selected,
                integrations: [],
            };
            await ensurePlainDirectory(files.stage, true);
            // Metadata gives a partially copied stage a bounded owned inventory for recovery.
            await writeOwnedFile(path.join(files.stage, INSTALLATION_MANIFEST), manifestBytes, {
                flag: 'wx',
            });
            await writeOwnedFile(
                path.join(files.stage, INSTALLATION_RECORD),
                JSON.stringify(record),
                {
                    flag: 'wx',
                },
            );
            await writeOwnedFile(path.join(files.stage, SETUP_OWNER), JSON.stringify(owner), {
                flag: 'wx',
            });
            journal = {
                schemaVersion: 1,
                product: INSTALLATION_PRODUCT,
                transactionId,
                installationId: id,
                root,
                candidateDigest: record.manifestSHA256,
                candidateVersion: candidate.version,
                oldDigest: current?.digest ?? null,
                phase: 'copying',
            };
            await this.savePhase(files, journal, 'copying');
            for (const item of candidate.files) {
                const destination = path.join(files.stage, ...item.path.split('/'));
                await ensurePlainDirectory(path.dirname(destination));
                await copyOwnedFile(
                    path.join(this.context.sourceRoot, ...item.path.split('/')),
                    destination,
                );
            }
            await copyOwnedFile(
                path.join(this.context.sourceRoot, SETUP_PAYLOAD),
                path.join(files.stage, SETUP_PAYLOAD),
            );
            await copyOwnedFile(uninstaller, path.join(files.stage, SETUP_UNINSTALLER));
            await this.verify(files.stage, manifest);
            await this.inventoryKnown(files.stage, manifest);
            await this.savePhase(files, journal, 'prepared');
            if (await this.context.busy(root))
                throw Error('The app became active during setup. Close it and review again.');
            if (current) {
                const fresh = await this.owned(root);
                if (fresh.digest !== current.digest || fresh.record.installationId !== id)
                    throw Error('Installation changed during verification.');
                await this.inventoryKnown(root, fresh.manifest);
                await this.requireInactive(root, files.stage, files.previous);
                await moveOwnedDirectory(root, files.previous);
            } else if (await exists(root)) {
                if ((await readdir(root)).length)
                    throw Error('The empty destination changed during verification.');
                await this.requireInactive(root, files.stage, files.previous);
                await removeOwnedDirectory(root);
            }
            await this.savePhase(files, journal, 'old-retained');
            await this.requireInactive(root, files.stage, files.previous);
            await moveOwnedDirectory(files.stage, root);
            await this.savePhase(files, journal, 'candidate-active');
            owner.integrations = await this.context.integrate(
                root,
                id,
                manifest.version,
                selected,
                current?.owner.integrations ?? [],
                async (records) => {
                    owner.integrations = records;
                    await atomicSetupJSON(path.join(root, SETUP_OWNER), owner);
                },
            );
            await atomicSetupJSON(path.join(root, SETUP_OWNER), owner);
            // Previous payload remains until a trusted UI/native boot acknowledgement is checked.
            return {
                root,
                installationId: id,
                version: manifest.version,
                profile: path.join(this.context.appData, 'DiagnosticHub', 'profiles', id),
                previousRetained: Boolean(current),
                launchRequested: false,
            };
        } catch (error) {
            if (journal) await this.rollbackLocked(root, journal).catch(() => {});
            throw error;
        } finally {
            await release();
        }
    }
    private async rollbackLocked(root: string, journal: Journal) {
        const files = this.places(root, journal.transactionId);
        if (journal.phase === 'candidate-confirmed')
            throw Error('The update is committed; finish confirmed cleanup instead of rollback.');
        if (
            (await this.context.busy(root)) ||
            (await this.context.busy(files.stage)) ||
            (await this.context.busy(files.previous))
        )
            throw Error('Close the app before recovery.');
        let ledger: CleanupLedger;
        if (journal.phase === 'rolling-back') ledger = await this.cleanupLedger(root, journal);
        else {
            if ((await exists(root)) && (await readdir(root)).length) {
                const current = await this.owned(root);
                if (current.record.installationId !== journal.installationId)
                    throw Error('Recovery installation identity differs.');
                if (
                    current.digest === journal.candidateDigest &&
                    current.owner.transactionId === journal.transactionId
                ) {
                    await this.inventoryKnown(root, current.manifest);
                    if (await exists(files.stage)) throw Error('Recovery stage conflict.');
                    await this.requireInactive(root, files.stage, files.previous);
                    await moveOwnedDirectory(root, files.stage);
                } else if (current.digest !== journal.oldDigest)
                    throw Error('An unrecognized install occupies the recovery destination.');
            }
            if (await exists(files.previous)) {
                const old = await this.ownedAtMoved(files.previous, root);
                if (
                    old.digest !== journal.oldDigest ||
                    old.record.installationId !== journal.installationId
                )
                    throw Error('Recovery backup identity differs.');
                await this.inventoryKnown(files.previous, old.manifest);
                if (await exists(root))
                    throw Error('Recovery will not overwrite an existing directory.');
                await this.requireInactive(root, files.stage, files.previous);
                await moveOwnedDirectory(files.previous, root);
            }
            const staged = (await exists(files.stage))
                ? await this.ownedAtMoved(files.stage, root)
                : null;
            if (staged) {
                this.validateSnapshot(
                    staged,
                    root,
                    journal.installationId,
                    journal.candidateDigest,
                    journal.candidateVersion,
                );
                if (staged.owner.transactionId !== journal.transactionId)
                    throw Error('Recovery stage identity differs.');
                await this.inventoryKnown(files.stage, staged.manifest);
                this.context.validateIntegrations(
                    root,
                    journal.installationId,
                    staged.owner.integrations,
                );
            }
            ledger = await this.prepareCleanup(root, journal, 'rollback', staged);
        }
        if (await exists(files.previous))
            throw Error('Rollback cleanup still has an unexpected previous slot.');
        let restored: Owned | null = null;
        if (journal.oldDigest !== null) {
            restored = await this.owned(root);
            if (
                restored.digest !== journal.oldDigest ||
                restored.record.installationId !== journal.installationId ||
                restored.owner.transactionId === journal.transactionId
            )
                throw Error('Restored installation identity differs.');
            await this.inventoryKnown(root, restored.manifest);
            this.context.validateIntegrations(
                root,
                journal.installationId,
                restored.owner.integrations,
            );
        } else if ((await exists(root)) && (await readdir(root)).length)
            throw Error('Rollback of a new installation must not replace an existing folder.');
        await this.requireInactive(root, files.stage, files.previous);
        if (ledger.owned) {
            this.context.validateIntegrations(
                root,
                journal.installationId,
                ledger.owned.owner.integrations,
            );
            await this.context.removeIntegrations(
                root,
                journal.installationId,
                ledger.owned.owner.integrations,
            );
        }
        if (restored) {
            const old = restored;
            old.owner.integrations = await this.context.integrate(
                root,
                old.record.installationId,
                old.manifest.version,
                old.owner.options,
                old.owner.integrations,
                async (records) => {
                    old.owner.integrations = records;
                    await atomicSetupJSON(path.join(root, SETUP_OWNER), old.owner);
                },
            );
            await atomicSetupJSON(path.join(root, SETUP_OWNER), old.owner);
        }
        if (ledger.owned) await this.removeTree(files.stage, ledger.owned.manifest, 'rollback');
        else if (await exists(files.stage))
            throw Error('An unrecognized stage occupies the cleanup slot.');
        await this.completeCleanup(root, journal);
    }
    private async ownedAtMoved(directory: string, original: string) {
        await plainDirectory(directory);
        // Ownership binds the final root, including while its exact bytes occupy a stage/backup.
        const ownerFile = path.join(directory, SETUP_OWNER),
            raw = (await boundedSetupJSON(ownerFile)) as Ownership;
        if (!same(raw.root, original)) throw Error('Moved payload ownership is invalid.');
        const record = validateInstallationRecord(
            await boundedSetupJSON(path.join(directory, INSTALLATION_RECORD)),
        );
        const bytes = await readFile(path.join(directory, INSTALLATION_MANIFEST));
        if (bytes.length > MAX_INSTALLATION_MANIFEST_BYTES || hash(bytes) !== record.manifestSHA256)
            throw Error('Moved payload metadata differs.');
        const manifest = validateInstallationManifest(JSON.parse(bytes.toString('utf8')));
        if (raw.product !== INSTALLATION_PRODUCT || raw.installationId !== record.installationId)
            throw Error('Moved ownership identity differs.');
        options(raw.options);
        return { record, manifest, owner: raw, digest: record.manifestSHA256 };
    }
    async rollback(input: string, token: string, consent: boolean) {
        if (!consent) throw Error('Confirm recovery.');
        const probe = await this.probe(input);
        if (probe.reviewToken !== token || probe.state !== 'recovery')
            throw Error('Review the current recovery state.');
        const release = await this.acquire(probe.root);
        try {
            const journal = await this.journal(probe.root);
            if (!journal) throw Error('No owned recovery transaction.');
            if (journal.phase === 'candidate-confirmed')
                throw Error(
                    'The update is committed; finish confirmed cleanup instead of rollback.',
                );
            if ((await this.probe(probe.root)).reviewToken !== token)
                throw Error('Recovery state changed. Review again.');
            if (journal.operation === 'remove')
                throw Error(
                    'Resume the confirmed removal; removed application files cannot be rolled back.',
                );
            await this.rollbackLocked(probe.root, journal);
            return { recovered: true, root: probe.root };
        } finally {
            await release();
        }
    }
    async finalize(input: string) {
        const root = await this.destination(input);
        const journal = await this.journal(root);
        if (!journal) return { confirmed: false, previousRetained: false };
        if (!['candidate-active', 'candidate-confirmed'].includes(journal.phase))
            throw Error('Recover the interrupted setup first.');
        const current = await this.owned(root);
        if (
            current.digest !== journal.candidateDigest ||
            current.record.installationId !== journal.installationId ||
            current.owner.transactionId !== journal.transactionId
        )
            throw Error('Candidate identity changed.');
        const ack = (await boundedSetupJSON(maintenancePaths(root).ack)) as Record<string, unknown>;
        if (
            ack.schemaVersion !== 1 ||
            ack.product !== INSTALLATION_PRODUCT ||
            typeof ack.nativeExecutable !== 'string' ||
            !same(ack.nativeExecutable, path.join(root, current.manifest.entryPoint)) ||
            ack.transactionId !== journal.transactionId ||
            ack.installationId !== journal.installationId ||
            ack.version !== journal.candidateVersion ||
            ack.manifestSHA256 !== journal.candidateDigest ||
            !same(String(ack.root), root)
        )
            throw Error('A matching native/UI successor has not been observed.');
        const expectedProfile = await realpath(
            path.join(this.context.appData, 'DiagnosticHub', 'profiles', journal.installationId),
        );
        if (
            typeof ack.profile !== 'string' ||
            !same(await realpath(ack.profile), expectedProfile) ||
            typeof ack.processCreationMs !== 'number' ||
            !Number.isFinite(ack.processCreationMs) ||
            typeof journal.candidateActivatedAt !== 'number' ||
            ack.processCreationMs < journal.candidateActivatedAt - 1
        )
            throw Error('Successor creation/profile identity differs.');
        if (
            !Number.isInteger(ack.pid) ||
            Number(ack.pid) < 1 ||
            !(await this.context.successorObserved(
                root,
                {
                    pid: Number(ack.pid),
                    creationTimeMs: ack.processCreationMs,
                    profile: ack.profile,
                },
                journal.candidateVersion,
            ))
        )
            throw Error('The matching successor native window is not currently observed.');
        const release = await this.acquire(root);
        try {
            const latest = await this.journal(root);
            if (
                !latest ||
                latest.transactionId !== journal.transactionId ||
                (await this.owned(root)).digest !== journal.candidateDigest
            )
                throw Error('Confirmation state changed.');
            const confirmedCurrent = await this.owned(root);
            if (
                confirmedCurrent.owner.transactionId !== journal.transactionId ||
                confirmedCurrent.record.installationId !== journal.installationId
            )
                throw Error('Successor installation identity changed.');
            await this.inventoryKnown(root, confirmedCurrent.manifest);
            await this.verify(root, confirmedCurrent.manifest);
            if (
                !(await this.context.successorObserved(
                    root,
                    {
                        pid: Number(ack.pid),
                        creationTimeMs: ack.processCreationMs,
                        profile: ack.profile,
                    },
                    journal.candidateVersion,
                ))
            )
                throw Error('The matching successor native window changed during confirmation.');
            const files = this.places(root, journal.transactionId);
            let ledger: CleanupLedger;
            if (journal.phase === 'candidate-confirmed')
                ledger = await this.cleanupLedger(root, journal);
            else {
                const previous = (await exists(files.previous))
                    ? await this.ownedAtMoved(files.previous, root)
                    : null;
                if (previous) {
                    this.validateSnapshot(
                        previous,
                        root,
                        journal.installationId,
                        journal.oldDigest ?? '',
                    );
                    await this.inventoryKnown(files.previous, previous.manifest);
                } else if (journal.oldDigest !== null)
                    throw Error('The retained previous payload is missing before confirmation.');
                await this.requireInactive(files.previous);
                ledger = await this.prepareCleanup(root, journal, 'finalize', previous);
            }
            if (ledger.owned)
                await this.removeTree(files.previous, ledger.owned.manifest, 'finalize');
            else if (await exists(files.previous))
                throw Error('An unexpected previous slot occupies confirmed cleanup.');
            await this.completeCleanup(root, journal);
            return { confirmed: true, previousRetained: false };
        } finally {
            await release();
        }
    }
    private async removalSnapshot(root: string, journal: Journal): Promise<Owned> {
        const filename = this.places(root, journal.transactionId).removalSnapshot;
        await regular(filename);
        const value = (await boundedSetupJSON(
            filename,
            MAX_INSTALLATION_MANIFEST_BYTES + 65536,
        )) as Owned;
        const bytes = await readFile(filename);
        if (hash(bytes) !== journal.removalSnapshotSHA256)
            throw Error('Removal recovery snapshot differs; preserve all remaining files.');
        return this.validateSnapshot(
            value,
            root,
            journal.installationId,
            journal.candidateDigest,
            journal.candidateVersion,
        );
    }
    private async finishRemovalLocked(root: string, journal: Journal) {
        const files = this.places(root, journal.transactionId),
            snapshot = await this.removalSnapshot(root, journal);
        this.context.validateIntegrations(
            root,
            journal.installationId,
            snapshot.owner.integrations,
        );
        if ((await this.context.busy(root)) || (await this.context.busy(files.previous)))
            throw Error('Close the app before resuming removal; no process will be terminated.');
        if (await exists(root)) {
            if (journal.phase !== 'remove-prepared' || (await exists(files.previous)))
                throw Error('An unexpected directory occupies the removal destination.');
            const current = await this.owned(root);
            if (
                current.digest !== journal.candidateDigest ||
                current.record.installationId !== journal.installationId
            )
                throw Error('Removal installation identity changed.');
            await this.inventoryKnown(root, current.manifest);
            await this.requireInactive(root, files.previous);
            await moveOwnedDirectory(root, files.previous);
        }
        if (journal.phase === 'remove-prepared')
            await this.savePhase(files, journal, 'remove-retained');
        if (await exists(files.previous)) {
            await this.inventoryKnown(files.previous, snapshot.manifest);
            // Snapshot and journal remain outside the tree until every owned file and integration
            // is gone. Recovery never needs partially deleted metadata from that tree.
            for (const entry of snapshot.manifest.files) {
                const filename = path.join(files.previous, ...entry.path.split('/'));
                if (await exists(filename)) {
                    await regular(filename);
                    await this.requireInactive(files.previous);
                    await unlinkOwnedFile(filename);
                    await this.context.onDelete?.({
                        operation: 'remove',
                        relativePath: entry.path,
                        kind: 'file',
                    });
                }
            }
        }
        if (['remove-retained', 'remove-payload'].includes(journal.phase))
            await this.savePhase(files, journal, 'remove-payload');
        await this.context.removeIntegrations(
            root,
            journal.installationId,
            snapshot.owner.integrations,
        );
        await this.savePhase(files, journal, 'remove-integrations');
        await this.removeTree(files.previous, snapshot.manifest, 'remove');
        await this.savePhase(files, journal, 'remove-complete');
        if (await exists(files.ack)) await unlinkOwnedFile(files.ack);
        // The journal is the commit marker. An orphaned immutable snapshot after this unlink
        // is harmless; deleting it first would make an interrupted commit unrecoverable.
        await unlinkOwnedFile(files.journal);
        await unlinkOwnedFile(files.removalSnapshot);
        return {
            removed: true,
            profileRetained: true,
            profile: path.join(
                this.context.appData,
                'DiagnosticHub',
                'profiles',
                journal.installationId,
            ),
        };
    }
    async remove(input: string, token: string, consent: boolean) {
        if (!consent) throw Error('Confirm removal; settings/reports will be retained.');
        const probe = await this.probe(input);
        if (
            probe.reviewToken !== token ||
            !(probe.state === 'owned' || probe.actions.includes('finishremove'))
        )
            throw Error('Review the current removal state first.');
        const root = probe.root,
            release = await this.acquire(root);
        try {
            const pending = await this.journal(root);
            if (pending?.operation === 'remove') {
                if (hash(JSON.stringify({ root, journal: pending })) !== token)
                    throw Error('Removal recovery state changed. Review again.');
                return await this.finishRemovalLocked(root, pending);
            }
            if (await this.context.busy(root))
                throw Error('Close the app before removal; no process will be terminated.');
            if ((await this.probe(root)).reviewToken !== token)
                throw Error('Reviewed removal changed while acquiring maintenance. Review again.');
            await this.discardCompletedInitial(root);
            const current = await this.owned(root);
            this.context.validateIntegrations(
                root,
                current.record.installationId,
                current.owner.integrations,
            );
            await this.inventoryKnown(root, current.manifest);
            const transactionId = randomUUID(),
                files = this.places(root, transactionId);
            const bytes = Buffer.from(JSON.stringify(current));
            if (bytes.length > MAX_INSTALLATION_MANIFEST_BYTES + 65536)
                throw Error('Removal snapshot exceeds its bound.');
            await assertPlainAncestors(files.removalSnapshot);
            const snapshotHandle = await open(files.removalSnapshot, 'wx', 0o600);
            try {
                await snapshotHandle.writeFile(bytes);
                await snapshotHandle.sync();
            } finally {
                await snapshotHandle.close();
            }
            const journal: Journal = {
                schemaVersion: 1,
                product: INSTALLATION_PRODUCT,
                transactionId,
                installationId: current.record.installationId,
                root,
                candidateDigest: current.digest,
                candidateVersion: current.manifest.version,
                oldDigest: current.digest,
                operation: 'remove',
                removalSnapshotSHA256: hash(bytes),
                phase: 'remove-prepared',
            };
            await this.savePhase(files, journal, 'remove-prepared');
            return await this.finishRemovalLocked(root, journal);
        } finally {
            await release();
        }
    }
    async launch(input: string) {
        const root = await this.destination(input);
        if (await exists(maintenancePaths(root).lock))
            throw Error('Finish current maintenance before launch.');
        await this.owned(root);
        await this.context.launch(root);
        return { launchRequested: true, root };
    }
}
