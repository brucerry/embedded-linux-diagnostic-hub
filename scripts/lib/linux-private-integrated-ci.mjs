import path from 'node:path';
import { accountLinuxCIUpload, ciHash, ciJSON, LINUX_CI_ASSETS } from './linux-artifact-ci.mjs';

export { LINUX_CI_LIMITS, LINUX_CI_ASSETS, LINUX_CI_METADATA, ciHash, ciJSON,
    requireLinuxCISpace, accountLinuxCIUpload, verifyLinuxCIUploadReadback,
    privateLinuxCIRecord, inventoryLinuxCIFlat, createLinuxCINpmConfigs,
    verifyLinuxCINpmConfigs } from './linux-artifact-ci.mjs';

export const PRIVATE_SOURCE = Object.freeze({
    commit: '4745d466139031de2c81e5b3e3b19ea8b24d72bf',
    tree: '825f83b3489382bdf68518f4135e6cd60ebfec79',
    files: 907, bytes: 8860226,
    sha256: '3b1deb2366c3857b199b2f59d7861793a2fa2cd0e69dfd160d1a9239a1fd0cf5',
});
export const PACKAGE_REF = 'refs/heads/ci/integration216-linux-package-readback';
export const PACKAGE_BUILD_ID = 'e95f5e37029a4d34bd5dc53ba7f4cc38';
const hex = (v, n) => typeof v === 'string' && new RegExp('^[a-f0-9]{' + n + '}$').test(v);
const absolute = v => typeof v === 'string' && v.startsWith('/') && v !== '/' &&
    path.posix.normalize(v) === v && !/[\\\x00-\x1f\x7f]/.test(v);

export function validatePackageInput(input) {
    const v = structuredClone(input);
    if (!v || Object.keys(v).sort().join(',') !==
        'appSHA,artifactOnly,buildId,event,ref,repository,runAttempt,runId,workflowFileSHA,workflowSHA' ||
        v.event !== 'push' || v.artifactOnly !== true ||
        v.repository !== 'brucerry/embedded-linux-diagnostic-hub' || v.ref !== PACKAGE_REF ||
        v.appSHA !== PRIVATE_SOURCE.commit || !hex(v.workflowSHA, 40) ||
        v.workflowSHA === v.appSHA || v.workflowFileSHA !== v.workflowSHA ||
        v.runAttempt !== '1' || typeof v.runId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(v.runId) ||
        v.buildId !== PACKAGE_BUILD_ID) throw Error('CI_INPUT');
    return v;
}

const injection = ['NODE_OPTIONS', 'NODE_PATH', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE',
    'NODE_USE_ENV_PROXY', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'NODE_V8_COVERAGE',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'LD_PRELOAD', 'LD_LIBRARY_PATH'];
export function requirePlainEnvironment(inherited) {
    for (const name of injection) if (inherited[name]) throw Error('CI_ENV');
    for (const [name, value] of Object.entries(inherited)) {
        if (value && /^(?:GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|REPLACE_REF_BASE|NO_REPLACE_OBJECTS|CONFIG.*))$/.test(name))
            throw Error('CI_GIT_ENV');
    }
    if (!absolute(inherited.HOME)) throw Error('CI_ENV');
}

/** Keep the inherited HOME and Git configuration. These are read-only Git queries. */
export function gitQueryEnvironment(inherited) {
    requirePlainEnvironment(inherited);
    return { HOME: inherited.HOME, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C',
        GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}

/** Query effective configuration; refuse external helpers instead of overriding settings. */
export function requireSafeGitQueries(query) {
    const monitor = query(['config', '--type=bool', '--get', 'core.fsmonitor']);
    if (!(monitor.status === 1 && monitor.stdout === '' ||
        monitor.status === 0 && monitor.stdout.trim() === 'false')) throw Error('CI_GIT_CONFIG');
    // Built-in read queries do not invoke hooks or clean/smudge filters. Leave those settings intact.
    for (const expression of ['^(extensions\\.partialclone|remote\\..*\\.promisor)$']) {
        const result = query(['config', '--name-only', '--get-regexp', expression]);
        if (result.status !== 1 || result.stdout !== '') throw Error('CI_GIT_CONFIG');
    }
    const replacements = query(['for-each-ref', 'refs/replace', '--format=%(refname)']);
    if (replacements.status !== 0 || replacements.stdout !== '') throw Error('CI_GIT_CONFIG');
}

export function packageEnvironment(inherited, node, workspace, root) {
    requirePlainEnvironment(inherited);
    if (!absolute(node) || !absolute(workspace) || !workspace.startsWith(inherited.HOME + '/') ||
        root !== path.posix.join(workspace, 'private-artifacts', PACKAGE_BUILD_ID)) throw Error('CI_ENV');
    // No inherited tokens, mirrors, npm overrides or unrelated runtime variables reach lifecycle scripts.
    return { HOME: inherited.HOME, PATH: path.posix.dirname(node) + ':/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8', LC_ALL: 'C', TZ: 'UTC', CI: 'true', NODE_DISABLE_COMPILE_CACHE: '1',
        NO_UPDATE_NOTIFIER: '1', NPM_CONFIG_USERCONFIG: root + '/npm-user.npmrc',
        NPM_CONFIG_GLOBALCONFIG: root + '/npm-global.npmrc', NPM_CONFIG_CACHE: root + '/npm-cache',
        ELECTRON_CACHE: root + '/electron-cache', ELECTRON_BUILDER_CACHE: root + '/builder-cache',
        XDG_CACHE_HOME: root + '/cache', npm_config_devdir: root + '/node-gyp-cache',
        TMPDIR: root + '/tmp', TMP: root + '/tmp', TEMP: root + '/tmp', GIT_TERMINAL_PROMPT: '0' };
}

export function packageArguments(phase, node) {
    if (!absolute(node)) throw Error('CI_ENV');
    const npm = path.posix.resolve(path.posix.dirname(node), '../lib/node_modules/npm/bin/npm-cli.js');
    const args = phase === 'dependencies' ? ['ci', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'] :
        phase === 'package' ? ['run', 'package:linux'] : null;
    if (!args) throw Error('CI_PHASE');
    return [npm, ...args];
}

/** Do not resolve on an error event; custody continues until the actual child's close event. */
export function observePackageChild(child) {
    return new Promise(resolve => {
        let error = null;
        child.once('error', value => { error = value; });
        child.once('close', (code, signal) => resolve({ code, signal, error,
            childCloseObserved: true, descendantRetirementQualified: false }));
    });
}

export function completedCommandReceipt(input, phase, completion) {
    const admitted = validatePackageInput(input);
    if (!['dependencies', 'package'].includes(phase) || completion.error || completion.code !== 0 ||
        completion.signal !== null || completion.childCloseObserved !== true ||
        completion.descendantRetirementQualified !== false) throw Error('CI_COMMAND');
    return { schema: 1, phase, input: admitted, status: 'command-closed-unqualified', code: 0,
        signal: null, childCloseObserved: true, descendantRetirementQualified: false };
}

export function validateCompletedCommand(record, input, phase) {
    const admitted = validatePackageInput(input), value = structuredClone(record);
    if (!value || value.schema !== 1 || value.phase !== phase ||
        value.status !== 'command-closed-unqualified' || value.code !== 0 || value.signal !== null ||
        value.childCloseObserved !== true || value.descendantRetirementQualified !== false ||
        JSON.stringify(validatePackageInput(value.input)) !== JSON.stringify(admitted)) throw Error('CI_COMMAND');
    return value;
}

/** Attempt every admitted close once, preserving primary failure and all close diagnostics. */
export async function retireOwnedHandles(primary, handles) {
    const errors = [];
    for (const handle of handles.filter(Boolean)) {
        try { await handle.close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) {
        const error = new AggregateError(primary.failed ? [primary.error, ...errors] : errors,
            'CI_CLOSE', { cause: primary.failed ? primary.error : errors[0] });
        error.code = 'CI_CLOSE';
        error.retirementProven = false;
        throw error;
    }
    if (primary.failed) throw primary.error;
}

export function nativeQualificationInputs(input, inventory, assetRows) {
    const admitted = validatePackageInput(input);
    if (!inventory || !Array.isArray(inventory.files) || inventory.files.length > 20000 ||
        !hex(inventory.inventorySHA256, 64) ||
        ciHash(Buffer.from(JSON.stringify(inventory.files))) !== inventory.inventorySHA256)
        throw Error('CI_NATIVE_IDENTITY');
    const selected = {};
    for (const [role, name] of [['executable', 'diagnostic-hub'], ['asar', 'resources/app.asar']]) {
        const rows = inventory.files.filter(f => f.path === name);
        if (rows.length !== 1) throw Error('CI_NATIVE_IDENTITY');
        const f = rows[0];
        if (!Number.isSafeInteger(f.bytes) || f.bytes < 1 || f.bytes > 2 * 1024 ** 3 ||
            !hex(f.sha256, 64) || !Number.isInteger(f.mode) || f.mode < 0 || f.mode > 0o777 ||
            (f.mode & 0o022) || !(f.mode & 0o400) || role === 'executable' && !(f.mode & 0o100))
            throw Error('CI_NATIVE_IDENTITY');
        selected[role] = { path: name, bytes: f.bytes, mode: f.mode, sha256: f.sha256 };
    }
    if (!Array.isArray(assetRows) || assetRows.length !== 2 ||
        new Set(assetRows.map(f => f.name)).size !== 2) throw Error('CI_NATIVE_IDENTITY');
    const assets = assetRows.map(f => {
        if (!LINUX_CI_ASSETS.includes(f.name) || !Number.isSafeInteger(f.bytes) ||
            f.bytes < 1 || f.bytes > 2 * 1024 ** 3 || !hex(f.sha256, 64)) throw Error('CI_NATIVE_IDENTITY');
        return { name: f.name, bytes: f.bytes, sha256: f.sha256 };
    }).sort((a, b) => a.name < b.name ? -1 : 1);
    return { applicationCommit: admitted.appSHA, applicationTree: PRIVATE_SOURCE.tree,
        toolingCommit: admitted.workflowSHA, buildId: admitted.buildId,
        flatInventorySHA256: inventory.inventorySHA256, assets, ...selected };
}

export function createCohortReceipt(input, files, accounting, inventory) {
    const admitted = validatePackageInput(input), cohort = accountLinuxCIUpload(files);
    const account = cohort.files.find(f => f.name === 'upload-accounting.json');
    if (!account || account.bytes !== accounting.bytes || account.sha256 !== accounting.sha256)
        throw Error('CI_CHANGED');
    const flat = cohort.files.find(f => f.name === 'flat-inventory.json'), bytes = ciJSON(inventory);
    if (bytes.length > 4 * 1024 ** 2 || flat.bytes !== bytes.length || flat.sha256 !== ciHash(bytes))
        throw Error('CI_CHANGED');
    return { schema: 1, kind: 'private-linux-cohort-receipt', status: 'built-unqualified',
        input: admitted, applicationTree: PRIVATE_SOURCE.tree, sourceSHA256: PRIVATE_SOURCE.sha256,
        files: cohort.files, assetBytes: cohort.assetBytes, metadataBytes: cohort.metadataBytes,
        nativeQualificationInputs: nativeQualificationInputs(admitted, inventory,
            cohort.files.filter(f => LINUX_CI_ASSETS.includes(f.name))),
        nativeValidation: 'unperformed', compiledSourceProven: false, handoffAllowed: false };
}

/** Context is independently verified service metadata, never data from the downloaded artifact.
 * The uploader cannot know its assigned artifact ID before upload. Pin it, the admitted run
 * and the successful terminal job before download; do not manufacture it from receipt fields. */
function validateReadbackJob(expected, observed) {
    const keys = ['workflowSHA', 'runId', 'runAttempt', 'jobId', 'artifactId'];
    if (!expected || Object.keys(expected).sort().join(',') !== keys.slice().sort().join(',') ||
        !hex(expected.workflowSHA, 40) || expected.runAttempt !== '1' ||
        !['runId', 'jobId', 'artifactId'].every(key => typeof expected[key] === 'string' &&
            /^[1-9][0-9]{0,19}$/.test(expected[key])) ||
        !observed || Object.keys(observed).sort().join(',') !== [...keys, 'status', 'conclusion'].sort().join(',') ||
        observed.status !== 'completed' || observed.conclusion !== 'success' ||
        !keys.every(key => observed[key] === expected[key])) throw Error('CI_RUN_BINDING');
    return structuredClone(expected);
}

/** Compare downloaded bytes only for the specifically selected successful job and artifact. */
export function verifyCohortReadback(receipt, files, expectedJob, observedJob, flatInventoryBytes) {
    const selected = validateReadbackJob(expectedJob, observedJob);
    const v = structuredClone(receipt), admitted = validatePackageInput(v?.input);
    if (admitted.runId !== selected.runId || admitted.runAttempt !== selected.runAttempt ||
        admitted.workflowSHA !== selected.workflowSHA) throw Error('CI_RUN_BINDING');
    if (Object.keys(v).sort().join(',') !== ['schema', 'kind', 'status', 'input', 'applicationTree', 'sourceSHA256',
        'files', 'assetBytes', 'metadataBytes', 'nativeQualificationInputs', 'nativeValidation',
        'compiledSourceProven', 'handoffAllowed'].sort().join(',') ||
        admitted.workflowSHA !== selected.workflowSHA || v.schema !== 1 ||
        v.kind !== 'private-linux-cohort-receipt' || v.status !== 'built-unqualified' ||
        v.applicationTree !== PRIVATE_SOURCE.tree || v.sourceSHA256 !== PRIVATE_SOURCE.sha256 ||
        v.nativeValidation !== 'unperformed' || v.compiledSourceProven !== false || v.handoffAllowed !== false)
        throw Error('CI_RECEIPT');
    const wanted = accountLinuxCIUpload(v.files), actual = accountLinuxCIUpload(files);
    if (JSON.stringify(wanted.files) !== JSON.stringify(actual.files) ||
        v.assetBytes !== actual.assetBytes || v.metadataBytes !== actual.metadataBytes) throw Error('CI_CHANGED');
    const flat = actual.files.find(f => f.name === 'flat-inventory.json');
    if (!(flatInventoryBytes instanceof Uint8Array) || flatInventoryBytes.length > 4 * 1024 ** 2 ||
        flatInventoryBytes.length !== flat.bytes || ciHash(flatInventoryBytes) !== flat.sha256)
        throw Error('CI_CHANGED');
    const native = nativeQualificationInputs(admitted, JSON.parse(Buffer.from(flatInventoryBytes).toString()),
        actual.files.filter(f => LINUX_CI_ASSETS.includes(f.name)));
    if (JSON.stringify(native) !== JSON.stringify(v.nativeQualificationInputs)) throw Error('CI_NATIVE_IDENTITY');
    return { status: 'readback-matched-unqualified', files: actual.files.length,
        runId: selected.runId, runAttempt: selected.runAttempt, jobId: selected.jobId, artifactId: selected.artifactId,
        handoffAllowed: false, nativeValidation: 'unperformed', accountingSHA256:
            actual.files.find(f => f.name === 'upload-accounting.json').sha256 };
}
