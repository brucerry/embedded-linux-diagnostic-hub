// Host metadata only. Importing this module does not inspect a host or run a command.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const BASELINE_BRANCH = 'refs/heads/ci/v060-macos-node-identity-20261116';
export const BASELINE_TOOLS = Object.freeze([
    '/bin/bash',
    '/usr/bin/git',
    '/usr/bin/curl',
    '/usr/bin/plutil',
    '/usr/bin/shasum',
    '/usr/bin/ditto',
    '/usr/bin/codesign',
    '/usr/bin/lipo',
    '/usr/bin/unzip',
    '/usr/bin/zipinfo',
    '/usr/sbin/lsof',
    '/usr/bin/stat',
    '/usr/bin/osascript',
    '/usr/bin/file',
    '/usr/libexec/PlistBuddy',
    '/usr/bin/sips',
    '/usr/bin/iconutil',
    '/usr/bin/uname',
    '/usr/sbin/sysctl',
    '/usr/bin/sw_vers',
]);
const phases = new Set([
    'context',
    'identity',
    'source',
    'architecture',
    'tools',
    'filesystem',
    'report',
]);
const reasons = new Set([
    'missing',
    'mismatch',
    'unavailable',
    'unsafe',
    'changed',
    'read-failed',
    'node-version',
    'node-access',
]);
class Refusal extends Error {
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}
const requireThat = (value, reason = 'mismatch') => {
    if (!value) throw new Refusal(reason);
};
const hex = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const id = (value) => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
function canonical(value) {
    requireThat(
        typeof value === 'string' &&
            value.length <= 4096 &&
            path.posix.isAbsolute(value) &&
            value !== '/' &&
            path.posix.normalize(value) === value &&
            !/[\\\x00-\x1f\x7f]/.test(value),
        'unsafe',
    );
    return value;
}
function stable(a, b) {
    for (const key of ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'])
        requireThat(typeof a[key] === 'bigint' && a[key] === b[key], 'changed');
    requireThat(a.kind === b.kind, 'changed');
}
function directory(file, ports) {
    canonical(file);
    requireThat(ports.realpath(file) === file, 'unsafe');
    const parts = file.slice(1).split('/');
    requireThat(parts.length <= 64, 'unsafe');
    for (let i = 0; i <= parts.length; i++) {
        const current = i ? '/' + parts.slice(0, i).join('/') : '/';
        const before = ports.stat(current);
        requireThat(before.kind === 'directory', 'unsafe');
        stable(before, ports.stat(current));
    }
}

/** Inertly testable collector; these results never authenticate CI or admit a product.
 * The real entry uses only preinstalled tools, metadata reads and fixed read-only queries.
 * Candidate payloads, GUI/TTY operation and native lifecycle are deliberately not observed. */
export function inspectMacHostBaseline(config, ports) {
    let stage = 'context';
    try {
        requireThat(
            config.repository === 'brucerry/embedded-linux-diagnostic-hub' &&
                config.repositoryId === '1405501450' &&
                config.private === 'false',
        );
        requireThat(
            config.actions === 'true' &&
                config.event === 'push' &&
                config.ref === BASELINE_BRANCH &&
                config.attempt === '1' &&
                id(config.runId),
        );
        requireThat(
            config.job === 'baseline' &&
                config.workflowRef ===
                    config.repository +
                        '/.github/workflows/macos-host-baseline.yml@' +
                        BASELINE_BRANCH,
        );
        requireThat(hex(config.sha) && config.workflowSHA === config.sha);
        requireThat(config.runner === 'github-hosted' && config.system === 'macOS');
        requireThat(
            ['x64', 'arm64'].includes(config.expectedArch) &&
                config.runnerArch === (config.expectedArch === 'x64' ? 'X64' : 'ARM64'),
        );

        stage = 'identity';
        const identity = ports.identity();
        requireThat(identity.platform === 'darwin' && identity.arch === config.expectedArch);
        requireThat(
            typeof identity.node === 'string' && /^24\.\d+\.\d+$/.test(identity.node),
            'node-version',
        );
        requireThat(
            Number.isSafeInteger(identity.uid) &&
                identity.uid > 0 &&
                identity.euid === identity.uid,
            'unsafe',
        );
        const executable = canonical(identity.executable),
            before = ports.stat(executable);
        requireThat(
            ports.realpath(executable) === executable &&
                before.kind === 'file' &&
                before.nlink === 1n,
            'unsafe',
        );
        requireThat(ports.executable(executable), 'node-access');
        stable(before, ports.stat(executable));

        stage = 'tools';
        for (const tool of BASELINE_TOOLS) {
            const selected = canonical(ports.realpath(tool)),
                meta = ports.stat(selected);
            requireThat(meta.kind === 'file' && ports.executable(tool), 'unavailable');
            stable(meta, ports.stat(selected));
            requireThat(ports.realpath(tool) === selected, 'changed');
        }

        stage = 'source';
        canonical(config.workspace);
        directory(config.workspace, ports);
        requireThat(ports.query('/usr/bin/git', ['rev-parse', '--verify', 'HEAD']) === config.sha);
        const tree = ports.query('/usr/bin/git', ['rev-parse', 'HEAD^{tree}']);
        requireThat(hex(tree));
        requireThat(
            ports.query('/usr/bin/git', [
                '-c',
                'core.fsmonitor=false',
                '-c',
                'core.untrackedCache=false',
                'status',
                '--porcelain',
                '--untracked-files=all',
            ]) === '',
            'changed',
        );

        stage = 'architecture';
        requireThat(ports.query('/usr/bin/uname', ['-s']) === 'Darwin');
        const machine = ports.query('/usr/bin/uname', ['-m']);
        const arm = ports.query('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']);
        requireThat(['0', '1'].includes(arm), 'unavailable');
        requireThat(machine === (config.expectedArch === 'arm64' ? 'arm64' : 'x86_64'));
        requireThat(arm === (config.expectedArch === 'arm64' ? '1' : '0'));
        const systemVersion = ports.query('/usr/bin/sw_vers', ['-productVersion']);
        requireThat(
            /^\d+\.\d+(?:\.\d+)?$/.test(systemVersion) && Number(systemVersion.split('.')[0]) >= 13,
            'unavailable',
        );

        stage = 'filesystem';
        directory(config.temp, ports);
        const space = ports.space(config.temp);
        requireThat(
            typeof space.bavail === 'bigint' &&
                space.bavail > 0n &&
                typeof space.bsize === 'bigint' &&
                space.bsize > 0n,
            'unavailable',
        );
        const slot = path.posix.join(
            config.temp,
            'hub-mac-baseline-' + config.runId + '-1-' + config.expectedArch,
        );
        requireThat(!ports.exists(slot), 'changed');
        return {
            classification: 'BASELINE_ONLY',
            stage: 'complete',
            reason: 'none',
            source: { commit: config.sha, tree },
            arch: identity.arch,
            node: identity.node,
            ordinaryUser: true,
            fixedToolsAvailable: true,
            freshSlot: 'absent-not-reserved',
            space: 'sampled-not-budgeted',
            candidateInputs: 'not-staged',
            gui: 'unverified',
            tty: 'unverified',
            nativeQualification: false,
            releaseAcceptance: false,
        };
    } catch (error) {
        return {
            classification: 'REFUSED',
            stage,
            reason:
                error instanceof Refusal && reasons.has(error.reason)
                    ? error.reason
                    : 'read-failed',
            nativeQualification: false,
            releaseAcceptance: false,
        };
    }
}

export function publishMacHostBaseline(result, output) {
    const unqualified = result.nativeQualification === false && result.releaseAcceptance === false;
    const good =
        unqualified &&
        result.classification === 'BASELINE_ONLY' &&
        result.stage === 'complete' &&
        result.reason === 'none';
    const refused =
        unqualified &&
        result.classification === 'REFUSED' &&
        phases.has(result.stage) &&
        reasons.has(result.reason);
    if (!good && !refused) return 1;
    try {
        output(
            'classification=' +
                result.classification +
                '\nstage=' +
                result.stage +
                '\nreason=' +
                result.reason +
                '\n',
        );
    } catch {
        return 1;
    }
    return good ? 0 : 1;
}

function nativePorts(workspace) {
    const stat = (file) => {
        const s = fs.lstatSync(file, { bigint: true });
        return {
            kind: s.isSymbolicLink()
                ? 'link'
                : s.isFile()
                  ? 'file'
                  : s.isDirectory()
                    ? 'directory'
                    : 'special',
            ...Object.fromEntries(
                ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map((key) => [
                    key,
                    s[key],
                ]),
            ),
        };
    };
    return {
        identity: () => ({
            platform: process.platform,
            arch: process.arch,
            node: process.versions.node,
            uid: process.getuid(),
            euid: process.geteuid(),
            executable: process.execPath,
        }),
        stat,
        realpath: (file) => fs.realpathSync(file),
        executable(file) {
            try {
                fs.accessSync(file, fs.constants.X_OK);
                return true;
            } catch {
                return false;
            }
        },
        space: (file) => fs.statfsSync(file, { bigint: true }),
        exists(file) {
            try {
                fs.lstatSync(file);
                return true;
            } catch (error) {
                if (error.code === 'ENOENT') return false;
                throw error;
            }
        },
        query(executable, args) {
            // Only the seven fixed metadata query vectors above reach this port. No shell,
            // retry, install, product code, dialog, sudo or manual process signal.
            return execFileSync(executable, args, {
                cwd: workspace,
                encoding: 'utf8',
                maxBuffer: 4096,
                stdio: ['ignore', 'pipe', 'ignore'],
                env: {
                    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
                    LC_ALL: 'C',
                    GIT_OPTIONAL_LOCKS: '0',
                },
            }).trim();
        },
    };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    // Read only named public context/path fields; no token or secret discovery.
    const env = process.env;
    const config = {
        repository: env.GITHUB_REPOSITORY,
        repositoryId: env.GITHUB_REPOSITORY_ID,
        private: env.BASELINE_REPOSITORY_PRIVATE,
        actions: env.GITHUB_ACTIONS,
        event: env.GITHUB_EVENT_NAME,
        ref: env.GITHUB_REF,
        attempt: env.GITHUB_RUN_ATTEMPT,
        runId: env.GITHUB_RUN_ID,
        job: env.GITHUB_JOB,
        sha: env.GITHUB_SHA,
        workflowSHA: env.GITHUB_WORKFLOW_SHA,
        workflowRef: env.GITHUB_WORKFLOW_REF,
        runner: env.RUNNER_ENVIRONMENT,
        system: env.RUNNER_OS,
        runnerArch: env.RUNNER_ARCH,
        expectedArch: env.BASELINE_EXPECTED_ARCH,
        workspace: env.GITHUB_WORKSPACE,
        temp: env.RUNNER_TEMP,
    };
    const result = inspectMacHostBaseline(config, nativePorts(config.workspace));
    // Reporting is the only explicit write: bounded allowlisted GitHub output-channel
    // values. A failed write cannot turn the result into a successful job.
    process.exitCode = publishMacHostBaseline(result, (text) => {
        if (Buffer.byteLength(text) > 256 || typeof env.GITHUB_OUTPUT !== 'string')
            throw Error('report');
        fs.appendFileSync(env.GITHUB_OUTPUT, text, { flag: 'a' });
    });
    console.log(JSON.stringify(result));
}
