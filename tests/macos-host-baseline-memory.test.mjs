import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
    BASELINE_BRANCH,
    BASELINE_TOOLS,
    inspectMacHostBaseline,
    publishMacHostBaseline,
} from '../.github/scripts/macos-host-baseline.mjs';

// No filesystem/process/query/report adapter is activated. Every port is authored data.
// The two workflow controls below read checked-in text only; no shell/option hook runs.
const workflow = readFileSync(
    new URL('../.github/workflows/macos-host-baseline.yml', import.meta.url),
    'utf8',
);
const startup = {
    BASH_ENV: '/dev/null',
    ENV: '/dev/null',
    NODE_OPTIONS: '',
    NODE_PATH: '',
    NODE_COMPILE_CACHE: '',
    NODE_DISABLE_COMPILE_CACHE: '1',
    ESBUILD_BINARY_PATH: '',
};
test('literal workflow startup controls precede every shell and checkout step', () => {
    const block = workflow.match(/^env:\n((?:    [A-Z_]+:.*\n)+)/m);
    assert.ok(block);
    const selected = Object.fromEntries(
        block[1]
            .trimEnd()
            .split('\n')
            .map((line) => {
                const match = line.match(/^    ([A-Z_]+): (.*)$/);
                assert.ok(match);
                const raw = match[2];
                return [match[1], raw.startsWith("'") ? raw.slice(1, -1) : raw];
            }),
    );
    assert.deepEqual(selected, startup);
    assert.ok(!block[0].includes('${{'));
    assert.ok(workflow.indexOf(block[0]) < workflow.indexOf('\njobs:'));
    assert.ok(workflow.indexOf(block[0]) < workflow.indexOf('actions/checkout@'));
});
test('job and step inputs cannot override startup assumptions', () => {
    const jobs = workflow.slice(workflow.indexOf('\njobs:'));
    for (const key of Object.keys(startup))
        assert.ok(!new RegExp('^ {8,}' + key + ':', 'm').test(jobs), key);
    assert.match(
        jobs,
        /unset BASH_ENV ENV NODE_OPTIONS NODE_PATH NODE_COMPILE_CACHE ESBUILD_BINARY_PATH/,
    );
    assert.ok(!jobs.includes('${{ secrets.') && !jobs.includes('${{ vars.'));
});

function fixture(arch = 'arm64') {
    const config = {
        repository: 'brucerry/embedded-linux-diagnostic-hub',
        repositoryId: '1405501450',
        private: 'false',
        actions: 'true',
        event: 'push',
        ref: BASELINE_BRANCH,
        attempt: '1',
        runId: '123',
        job: 'baseline',
        sha: 'c'.repeat(40),
        workflowSHA: 'c'.repeat(40),
        workflowRef:
            'brucerry/embedded-linux-diagnostic-hub/.github/workflows/macos-host-baseline.yml@' +
            BASELINE_BRANCH,
        runner: 'github-hosted',
        system: 'macOS',
        runnerArch: arch === 'arm64' ? 'ARM64' : 'X64',
        expectedArch: arch,
        workspace: '/task/source',
        temp: '/task/temp',
    };
    const calls = [];
    const identity = {
        platform: 'darwin',
        arch,
        node: '24.22.0',
        uid: 1000,
        euid: 1000,
        executable: '/tools/node',
    };
    const query = new Map([
        [['/usr/bin/git', 'rev-parse', '--verify', 'HEAD'].join('\0'), config.sha],
        [['/usr/bin/git', 'rev-parse', 'HEAD^{tree}'].join('\0'), 'd'.repeat(40)],
        [
            [
                '/usr/bin/git',
                '-c',
                'core.fsmonitor=false',
                '-c',
                'core.untrackedCache=false',
                'status',
                '--porcelain',
                '--untracked-files=all',
            ].join('\0'),
            '',
        ],
        [['/usr/bin/uname', '-s'].join('\0'), 'Darwin'],
        [['/usr/bin/uname', '-m'].join('\0'), arch === 'arm64' ? 'arm64' : 'x86_64'],
        [['/usr/sbin/sysctl', '-n', 'hw.optional.arm64'].join('\0'), arch === 'arm64' ? '1' : '0'],
        [['/usr/bin/sw_vers', '-productVersion'].join('\0'), '15.7.0'],
    ]);
    const dirs = new Set(['/', '/task', '/task/source', '/task/temp']);
    const ports = {
        identity() {
            calls.push(['identity']);
            return identity;
        },
        stat(file) {
            calls.push(['stat', file]);
            return {
                kind: dirs.has(file) ? 'directory' : 'file',
                dev: 1n,
                ino: 9007199254740997n,
                mode: 0o755n,
                uid: 1000n,
                nlink: 1n,
                size: 8n,
                mtimeNs: 1n,
                ctimeNs: 1n,
            };
        },
        realpath(file) {
            calls.push(['realpath', file]);
            return file;
        },
        executable(file) {
            calls.push(['executable', file]);
            return true;
        },
        space(file) {
            calls.push(['space', file]);
            return { bavail: 1024n, bsize: 4096n };
        },
        exists(file) {
            calls.push(['exists', file]);
            return false;
        },
        query(file, args) {
            calls.push(['query', file, args]);
            const key = [file, ...args].join('\0');
            assert.ok(query.has(key), 'No additional query is allowed.');
            return query.get(key);
        },
    };
    return { config, ports, identity, query, calls };
}
const inspect = (f) => inspectMacHostBaseline(f.config, f.ports);

for (const arch of ['x64', 'arm64']) {
    test(arch + ' Node version refusal is bounded and precedes all file or query ports', () => {
        for (const version of ['22.23.4', '24.22.0-rc.1', '24.22.0\nPRIVATE_VALUE', undefined]) {
            const f = fixture(arch);
            f.identity.node = version;
            const result = inspect(f);
            assert.deepEqual(result, {
                classification: 'REFUSED',
                stage: 'identity',
                reason: 'node-version',
                nativeQualification: false,
                releaseAcceptance: false,
            });
            assert.deepEqual(f.calls, [['identity']]);
            const writes = [];
            assert.equal(
                publishMacHostBaseline(result, (s) => writes.push(s)),
                1,
            );
            assert.deepEqual(writes, [
                'classification=REFUSED\nstage=identity\nreason=node-version\n',
            ]);
        }
    });
    test(arch + ' Node access refusal stays distinct and stops before tool or query ports', () => {
        const f = fixture(arch);
        f.ports.executable = (file) => {
            f.calls.push(['executable', file]);
            assert.equal(file, f.identity.executable);
            return false;
        };
        const result = inspect(f);
        assert.deepEqual(result, {
            classification: 'REFUSED',
            stage: 'identity',
            reason: 'node-access',
            nativeQualification: false,
            releaseAcceptance: false,
        });
        assert.deepEqual(f.calls, [
            ['identity'],
            ['stat', '/tools/node'],
            ['realpath', '/tools/node'],
            ['executable', '/tools/node'],
        ]);
        const writes = [];
        assert.equal(
            publishMacHostBaseline(result, (s) => writes.push(s)),
            1,
        );
        assert.deepEqual(writes, ['classification=REFUSED\nstage=identity\nreason=node-access\n']);
    });
}
test('Node access read errors and unknown report codes remain nonqualifying and private', () => {
    const f = fixture();
    f.ports.executable = () => {
        throw Error('PRIVATE_VALUE');
    };
    const result = inspect(f);
    assert.equal(result.classification, 'REFUSED');
    assert.equal(result.stage, 'identity');
    assert.equal(result.reason, 'read-failed');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_VALUE'));
    assert.equal(result.nativeQualification, false);
    assert.equal(result.releaseAcceptance, false);
    assert.ok(!f.calls.some(([kind]) => kind === 'query'));
    assert.equal(
        publishMacHostBaseline({ ...result, reason: 'node-access\nPRIVATE_VALUE' }, () =>
            assert.fail(),
        ),
        1,
    );
    assert.equal(
        publishMacHostBaseline(result, () => {
            throw Error('PRIVATE_VALUE');
        }),
        1,
    );
});

for (const arch of ['x64', 'arm64'])
    test('matching ' + arch + ' metadata reports baseline only', () => {
        const f = fixture(arch),
            result = inspect(f);
        assert.equal(result.classification, 'BASELINE_ONLY');
        assert.equal(result.arch, arch);
        assert.equal(result.nativeQualification, false);
        assert.equal(result.releaseAcceptance, false);
        assert.equal(result.candidateInputs, 'not-staged');
        assert.equal(result.gui, 'unverified');
        assert.equal(result.tty, 'unverified');
        assert.equal(result.freshSlot, 'absent-not-reserved');
        assert.equal(f.calls.filter(([kind]) => kind === 'query').length, 7);
        assert.equal(
            f.calls.filter(([kind]) => kind === 'executable').length,
            BASELINE_TOOLS.length + 1,
        );
        assert.ok(
            !JSON.stringify(result).includes('/task') && !JSON.stringify(result).includes('/tools'),
        );
    });

for (const [name, mutate, stage] of [
    [
        'private repository',
        (f) => {
            f.config.private = 'true';
        },
        'context',
    ],
    [
        'wrong repository ID',
        (f) => {
            f.config.repositoryId = '1';
        },
        'context',
    ],
    [
        'tag event substituted',
        (f) => {
            f.config.ref = 'refs/tags/v0.6.0';
        },
        'context',
    ],
    [
        'second attempt',
        (f) => {
            f.config.attempt = '2';
        },
        'context',
    ],
    [
        'wrong workflow source',
        (f) => {
            f.config.workflowSHA = 'e'.repeat(40);
        },
        'context',
    ],
    [
        'different workflow file',
        (f) => {
            f.config.workflowRef = f.config.workflowRef.replace('macos-host-baseline', 'release');
        },
        'context',
    ],
    [
        'self-hosted runner',
        (f) => {
            f.config.runner = 'self-hosted';
        },
        'context',
    ],
    [
        'wrong runner architecture',
        (f) => {
            f.config.runnerArch = 'X64';
        },
        'context',
    ],
    [
        'root user',
        (f) => {
            f.identity.uid = 0;
        },
        'identity',
    ],
    [
        'effective root user',
        (f) => {
            f.identity.euid = 0;
        },
        'identity',
    ],
    [
        'different effective identity',
        (f) => {
            f.identity.euid = 1001;
        },
        'identity',
    ],
    [
        'different process architecture',
        (f) => {
            f.identity.arch = 'x64';
        },
        'identity',
    ],
    [
        'wrong Node major',
        (f) => {
            f.identity.node = '22.0.0';
        },
        'identity',
    ],
    [
        'Node alias',
        (f) => {
            f.ports.realpath = (p) => (p === '/tools/node' ? '/other/node' : p);
        },
        'identity',
    ],
    [
        'Node multiple links',
        (f) => {
            const stat = f.ports.stat;
            f.ports.stat = (p) => ({ ...stat(p), ...(p === '/tools/node' ? { nlink: 2n } : {}) });
        },
        'identity',
    ],
    [
        'missing fixed tool',
        (f) => {
            f.ports.executable = (p) => p !== '/usr/bin/codesign';
        },
        'tools',
    ],
    [
        'changed metadata',
        (f) => {
            const stat = f.ports.stat;
            let n = 0;
            f.ports.stat = (p) => ({
                ...stat(p),
                ...(p === '/tools/node' ? { ino: BigInt(++n) } : {}),
            });
        },
        'identity',
    ],
    [
        'changed tool mapping',
        (f) => {
            let reads = 0;
            f.ports.realpath = (p) => (p === '/usr/bin/curl' && ++reads > 1 ? '/other/curl' : p);
        },
        'tools',
    ],
    [
        'wrong checkout SHA',
        (f) => {
            f.query.set(
                ['/usr/bin/git', 'rev-parse', '--verify', 'HEAD'].join('\0'),
                'e'.repeat(40),
            );
        },
        'source',
    ],
    [
        'untracked source',
        (f) => {
            f.query.set(
                [
                    '/usr/bin/git',
                    '-c',
                    'core.fsmonitor=false',
                    '-c',
                    'core.untrackedCache=false',
                    'status',
                    '--porcelain',
                    '--untracked-files=all',
                ].join('\0'),
                '?? private',
            );
        },
        'source',
    ],
    [
        'aliased workspace',
        (f) => {
            f.ports.realpath = (p) => (p === f.config.workspace ? '/other' : p);
        },
        'source',
    ],
    [
        'different hardware architecture',
        (f) => {
            f.query.set(['/usr/sbin/sysctl', '-n', 'hw.optional.arm64'].join('\0'), '0');
        },
        'architecture',
    ],
    [
        'unknown hardware query',
        (f) => {
            f.query.set(['/usr/sbin/sysctl', '-n', 'hw.optional.arm64'].join('\0'), '');
        },
        'architecture',
    ],
    [
        'old system version',
        (f) => {
            f.query.set(['/usr/bin/sw_vers', '-productVersion'].join('\0'), '12.7.0');
        },
        'architecture',
    ],
    [
        'aliased temp directory',
        (f) => {
            f.ports.realpath = (p) => (p === f.config.temp ? '/other' : p);
        },
        'filesystem',
    ],
    [
        'occupied slot',
        (f) => {
            f.ports.exists = () => true;
        },
        'filesystem',
    ],
    [
        'unobserved space',
        (f) => {
            f.ports.space = () => ({ bavail: 0n, bsize: 4096n });
        },
        'filesystem',
    ],
])
    test('refuses ' + name + ' without inferring qualification', () => {
        const f = fixture();
        mutate(f);
        const result = inspect(f);
        assert.equal(result.classification, 'REFUSED');
        assert.equal(result.stage, stage);
        assert.equal(result.nativeQualification, false);
        assert.equal(result.releaseAcceptance, false);
        if (stage === 'context') assert.equal(f.calls.length, 0);
    });

test('raw port errors and unused private fields cannot enter reports', () => {
    const f = fixture();
    Object.defineProperty(f.config, 'credentials', {
        get() {
            throw Error('must not be read');
        },
    });
    Object.defineProperty(f.identity, 'hostname', {
        get() {
            throw Error('must not be read');
        },
    });
    assert.equal(inspect(f).classification, 'BASELINE_ONLY');
    f.ports.space = () => {
        throw Error('PRIVATE_PATH_TOKEN');
    };
    const result = inspect(f);
    assert.equal(result.reason, 'read-failed');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_PATH_TOKEN'));
});
test('bounded reporting preserves failed results and rejects forged success', () => {
    const result = inspect(fixture()),
        writes = [];
    assert.equal(
        publishMacHostBaseline(result, (s) => writes.push(s)),
        0,
    );
    assert.equal(writes.length, 1);
    assert.ok(writes[0].length <= 256);
    assert.equal(
        publishMacHostBaseline(result, () => {
            throw Error('output failure');
        }),
        1,
    );
    assert.equal(
        publishMacHostBaseline({ ...result, nativeQualification: true }, () => assert.fail()),
        1,
    );
    assert.equal(
        publishMacHostBaseline({ ...result, stage: 'private-data' }, () => assert.fail()),
        1,
    );
    const f = fixture();
    f.config.attempt = '2';
    assert.equal(
        publishMacHostBaseline(inspect(f), (s) => assert.match(s, /classification=REFUSED/)),
        1,
    );
});
