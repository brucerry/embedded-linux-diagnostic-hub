import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import test from 'node:test';
import {
    ATTESTATION_VERIFIER_LIMITS,
    verifyLocalAttestation,
} from '../scripts/lib/attested-content-verifier.mjs';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture(kind: 'archive' | 'record' = 'archive') {
    const files = new Map<string, { bytes: Buffer; stat: any }>();
    const calls: { operation: string; path: string; args?: any; options?: any }[] = [];
    let inode = 10;
    const add = (file: string, bytes: Buffer, mode = 0o100600) => {
        const stat = {
            dev: 1,
            ino: inode++,
            uid: 1000,
            mode,
            nlink: 1,
            size: bytes.length,
            mtimeMs: 10,
            ctimeMs: 10,
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => false,
        };
        files.set(file, { bytes: Buffer.from(bytes), stat });
        return { path: file, bytes: bytes.length, sha256: hash(bytes) };
    };
    const subject = {
        ...add(
            '/selected/subject',
            Buffer.from(kind === 'record' ? '{"schema":1}\n' : 'opaque archive bytes'),
        ),
        kind,
        name: kind === 'record' ? 'content.json' : 'archive.tar.gz',
    };
    const bundle = add(
        '/selected/bundle.jsonl',
        Buffer.from('{"synthetic":"bundle-not-cryptographic-evidence"}\n'),
    );
    const executable = add(
        '/trusted/gh',
        Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]),
        0o100700,
    );
    const tool = { path: executable.path, sha256: executable.sha256, version: '2.102.0' };
    const trustedRoot = add(
        '/trusted/root.jsonl',
        Buffer.from('{"synthetic":"root-not-cryptographic-evidence"}\n'),
    );
    const directoryStat: any = {
        dev: 1,
        ino: 100,
        uid: 1000,
        mode: 0o40700,
        nlink: 2,
        size: 0,
        mtimeMs: 10,
        ctimeMs: 10,
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false,
    };
    const request = {
        subject,
        bundle,
        tool,
        trustedRoot,
        configurationDirectory: '/isolated',
        constraints: {
            repository: 'brucerry/embedded-linux-diagnostic-hub',
            certificateIdentity:
                'https://github.com/brucerry/embedded-linux-diagnostic-hub/.github/workflows/content.yml@refs/heads/reviewed',
            issuer: 'https://token.actions.githubusercontent.com',
            signerDigest: 'a'.repeat(40),
            sourceDigest: 'b'.repeat(40),
            sourceRef: 'refs/heads/reviewed',
            predicateType: 'https://embedded-linux-diagnostic-hub.dev/attestation/content/v1',
        },
    };
    const controls = {
        failure: '',
        readChunk: 65536,
        target: '',
        noncanonical: '',
        configEntries: [] as string[],
        version:
            'gh version 2.102.0 (synthetic)\nhttps://github.com/cli/cli/releases/tag/v2.102.0\n',
        stdout: Buffer.from('[{"verificationResult":{"synthetic":true}}]\n'),
        onExecute: (_args: string[]) => {},
    };
    const filesystem = {
        async realpath(file: string) {
            calls.push({ operation: 'realpath', path: file });
            return controls.noncanonical === file ? '/other/path' : file;
        },
        async lstat(file: string) {
            calls.push({ operation: 'lstat', path: file });
            if (controls.failure === 'lstat' && controls.target === file)
                throw Error('synthetic stat failure');
            const item = file === '/isolated' ? directoryStat : files.get(file)?.stat;
            if (!item) throw Error('missing synthetic file');
            return { ...item };
        },
        async readdir(file: string) {
            calls.push({ operation: 'readdir', path: file });
            return [...controls.configEntries];
        },
        async open(file: string, flags: number) {
            calls.push({ operation: 'open', path: file, args: flags });
            assert.equal(flags, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            if (controls.failure === 'open' && controls.target === file)
                throw Error('synthetic open failure');
            const item = files.get(file)!;
            return {
                async stat() {
                    if (controls.failure === 'fstat' && controls.target === file)
                        return { ...item.stat, ino: 999 };
                    return { ...item.stat };
                },
                async read(buffer: Buffer, offset: number, length: number, position: number) {
                    if (controls.target === file) {
                        if (controls.failure === 'read') throw Error('synthetic read failure');
                        if (controls.failure === 'invalid-read') return { bytesRead: length + 1 };
                        if (controls.failure === 'truncate') return { bytesRead: 0 };
                    }
                    const bytesRead = Math.max(
                        0,
                        Math.min(length, controls.readChunk, item.bytes.length - position),
                    );
                    item.bytes.copy(buffer, offset, position, position + bytesRead);
                    return { bytesRead };
                },
                async close() {
                    calls.push({ operation: 'close', path: file });
                    if (controls.failure === 'close' && controls.target === file)
                        throw Error('synthetic close failure');
                },
            };
        },
    };
    const execute = (file: string, args: string[], options: any) => {
        calls.push({ operation: 'execute', path: file, args: [...args], options });
        controls.onExecute(args);
        if (
            controls.failure === 'execute' ||
            (controls.failure === 'version-execute' && args[0] === '--version') ||
            (controls.failure === 'verify-execute' && args[0] === 'attestation')
        )
            throw Object.assign(Error('secret stdout must never escape'), {
                stdout: 'TOKEN_SECRET',
                stderr: 'CREDENTIAL_SECRET',
                status: 1,
            });
        return args[0] === '--version' ? Buffer.from(controls.version) : controls.stdout;
    };
    return {
        request,
        files,
        directoryStat,
        controls,
        calls,
        dependencies: { filesystem, execute, uid: 1000, platform: 'linux' },
        run: () =>
            verifyLocalAttestation(request, { filesystem, execute, uid: 1000, platform: 'linux' }),
        executions: () => calls.filter((call) => call.operation === 'execute'),
    };
}

test('synthetic adapter executes only fixed offline verification and returns fresh output without archive body', async () => {
    const f = fixture(),
        result = await f.run();
    assert.deepEqual(result.subject, {
        kind: 'archive',
        name: 'archive.tar.gz',
        bytes: f.request.subject.bytes,
        sha256: f.request.subject.sha256,
    });
    assert.ok(!('recordBytes' in result));
    assert.deepEqual(result.verificationResults, [{ verificationResult: { synthetic: true } }]);
    assert.deepEqual(result.verifier, {
        toolSHA256: f.request.tool.sha256,
        toolVersion: '2.102.0',
        trustedRootSHA256: f.request.trustedRoot.sha256,
        bundleSHA256: f.request.bundle.sha256,
    });
    const executions = f.executions();
    assert.equal(executions.length, 2);
    assert.deepEqual(executions[0].args, ['--version']);
    assert.deepEqual(executions[1].args, [
        'attestation',
        'verify',
        '/selected/subject',
        '--bundle',
        '/selected/bundle.jsonl',
        '--custom-trusted-root',
        '/trusted/root.jsonl',
        '--repo',
        f.request.constraints.repository,
        '--hostname',
        'github.com',
        '--cert-identity',
        f.request.constraints.certificateIdentity,
        '--cert-oidc-issuer',
        f.request.constraints.issuer,
        '--signer-digest',
        'a'.repeat(40),
        '--source-digest',
        'b'.repeat(40),
        '--source-ref',
        'refs/heads/reviewed',
        '--deny-self-hosted-runners',
        '--digest-alg',
        'sha256',
        '--format',
        'json',
        '--predicate-type',
        f.request.constraints.predicateType,
    ]);
    for (const execution of executions) {
        assert.equal(execution.path, '/trusted/gh');
        assert.equal(execution.options.shell, false);
        assert.equal(execution.options.timeout, 30000);
        assert.deepEqual(execution.options.stdio, ['ignore', 'pipe', 'pipe']);
        assert.deepEqual(execution.options.env, {
            HOME: '/isolated',
            GH_CONFIG_DIR: '/isolated',
            XDG_CONFIG_HOME: '/isolated',
            XDG_CACHE_HOME: '/isolated',
            GH_HOST: 'github.com',
            GH_PROMPT_DISABLED: '1',
            GH_NO_UPDATE_NOTIFIER: '1',
            GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
            NO_COLOR: '1',
            TERM: 'dumb',
            LC_ALL: 'C',
        });
        assert.ok(Object.isFrozen(execution.options.env));
    }
    assert.equal(f.calls.filter((c) => c.operation === 'open').length, 12);
    assert.equal(f.calls.filter((c) => c.operation === 'close').length, 12);
});

test('record returns only bounded selected bytes from the same stably verified subject', async () => {
    const f = fixture('record'),
        result = await f.run();
    assert.deepEqual(result.recordBytes, f.files.get('/selected/subject')!.bytes);
    assert.notEqual(result.recordBytes, f.files.get('/selected/subject')!.bytes);
    assert.equal(result.subject.kind, 'record');
});

for (const [label, mutate] of [
    [
        'extra imported result',
        (f: any) => {
            f.request.verificationResults = [];
        },
    ],
    [
        'missing independent digest',
        (f: any) => {
            delete f.request.bundle.sha256;
        },
    ],
    [
        'foreign repository',
        (f: any) => {
            f.request.constraints.repository = 'attacker/repo';
        },
    ],
    [
        'foreign issuer',
        (f: any) => {
            f.request.constraints.issuer = 'https://attacker';
        },
    ],
    [
        'foreign predicate',
        (f: any) => {
            f.request.constraints.predicateType = 'https://slsa.dev/provenance/v1';
        },
    ],
    [
        'unpinned signer',
        (f: any) => {
            f.request.constraints.signerDigest = 'main';
        },
    ],
    [
        'unpinned source',
        (f: any) => {
            f.request.constraints.sourceDigest = 'main';
        },
    ],
    [
        'option-like ref',
        (f: any) => {
            f.request.constraints.sourceRef = '--repo=attacker';
        },
    ],
    [
        'relative path',
        (f: any) => {
            f.request.subject.path = 'subject';
        },
    ],
    [
        'aliased paths',
        (f: any) => {
            f.request.bundle.path = f.request.subject.path;
        },
    ],
    [
        'unknown subject',
        (f: any) => {
            f.request.subject.kind = 'executable';
        },
    ],
    [
        'archive bound',
        (f: any) => {
            f.request.subject.bytes = ATTESTATION_VERIFIER_LIMITS.subject + 1;
        },
    ],
    [
        'record bound',
        (f: any) => {
            f.request.subject.kind = 'record';
            f.request.subject.bytes = ATTESTATION_VERIFIER_LIMITS.record + 1;
        },
    ],
    [
        'old verifier',
        (f: any) => {
            f.request.tool.version = '2.46.0';
        },
    ],
    [
        'unaudited verifier major',
        (f: any) => {
            f.request.tool.version = '3.0.0';
        },
    ],
    [
        'prerelease verifier',
        (f: any) => {
            f.request.tool.version = '2.102.0-preview';
        },
    ],
] as const)
    test('preflight refuses ' + label + ' without execution', async () => {
        const f = fixture();
        mutate(f);
        await assert.rejects(f.run());
        assert.equal(f.executions().length, 0);
    });

for (const target of [
    '/selected/subject',
    '/selected/bundle.jsonl',
    '/trusted/gh',
    '/trusted/root.jsonl',
]) {
    for (const failure of ['lstat', 'open', 'fstat', 'read', 'invalid-read', 'truncate', 'close'])
        test('preflight refuses ' + failure + ' at ' + target, async () => {
            const f = fixture();
            f.controls.failure = failure;
            f.controls.target = target;
            await assert.rejects(f.run());
            assert.equal(f.executions().length, 0);
            if (!['lstat', 'open'].includes(failure))
                assert.ok(f.calls.some((c) => c.operation === 'close' && c.path === target));
        });
    for (const [label, mutate] of [
        [
            'symlink',
            (v: any) => {
                v.stat.isSymbolicLink = () => true;
            },
        ],
        [
            'hardlink',
            (v: any) => {
                v.stat.nlink = 2;
            },
        ],
        [
            'special type',
            (v: any) => {
                v.stat.isFile = () => false;
            },
        ],
        [
            'shared write',
            (v: any) => {
                v.stat.mode |= 0o020;
            },
        ],
        [
            'setuid',
            (v: any) => {
                v.stat.mode |= 0o4000;
            },
        ],
        [
            'foreign owner',
            (v: any) => {
                v.stat.uid = 1001;
            },
        ],
        [
            'wrong size',
            (v: any) => {
                v.stat.size += 1;
            },
        ],
        [
            'wrong digest',
            (v: any) => {
                v.bytes[4] ^= 1;
            },
        ],
    ] as const)
        test('preflight refuses ' + label + ' at ' + target, async () => {
            const f = fixture();
            mutate(f.files.get(target));
            await assert.rejects(f.run());
            assert.equal(f.executions().length, 0);
        });
    test('noncanonical path refused at ' + target, async () => {
        const f = fixture();
        f.controls.noncanonical = target;
        await assert.rejects(f.run());
        assert.equal(f.executions().length, 0);
    });
    for (const stage of ['--version', 'attestation'])
        test(
            'post-execution persistent byte drift refused for ' + target + ' after ' + stage,
            async () => {
                const f = fixture();
                f.controls.onExecute = (args) => {
                    if (args[0] === stage) f.files.get(target)!.bytes[4] ^= 1;
                };
                await assert.rejects(f.run());
                assert.equal(f.executions().length, stage === '--version' ? 1 : 2);
            },
        );
    test('post-verification identity drift refused at ' + target, async () => {
        const f = fixture();
        f.controls.onExecute = (args) => {
            if (args[0] === 'attestation') f.files.get(target)!.stat.ino++;
        };
        await assert.rejects(f.run());
        assert.equal(f.executions().length, 2);
    });
}

for (const [label, mutate] of [
    [
        'populated configuration',
        (f: any) => {
            f.controls.configEntries = ['hosts.yml'];
        },
    ],
    [
        'shared configuration',
        (f: any) => {
            f.directoryStat.mode = 0o40750;
        },
    ],
    [
        'foreign configuration',
        (f: any) => {
            f.directoryStat.uid = 0;
        },
    ],
    [
        'symlink configuration',
        (f: any) => {
            f.directoryStat.isSymbolicLink = () => true;
        },
    ],
    [
        'noncanonical configuration',
        (f: any) => {
            f.controls.noncanonical = '/isolated';
        },
    ],
    [
        'non-native verifier',
        (f: any) => {
            const v = f.files.get('/trusted/gh');
            v.bytes[0] = 35;
            f.request.tool.sha256 = hash(v.bytes);
        },
    ],
    [
        'non-executable verifier',
        (f: any) => {
            f.files.get('/trusted/gh').stat.mode = 0o100600;
        },
    ],
    [
        'unterminated root JSONL',
        (f: any) => {
            const v = f.files.get('/trusted/root.jsonl');
            v.bytes[v.bytes.length - 1] = 32;
            f.request.trustedRoot.sha256 = hash(v.bytes);
        },
    ],
] as const)
    test('refuses ' + label + ' before execution', async () => {
        const f = fixture();
        mutate(f);
        await assert.rejects(f.run());
        assert.equal(f.executions().length, 0);
    });

for (const value of [
    'gh version 2.46.0\n',
    'gh version 2.103.0\n',
    '\uFEFFgh version 2.102.0\n',
    '2.102.0',
    'gh version 2.102.0\nextra\n',
])
    test(
        'version output must match exact supported selection: ' + JSON.stringify(value),
        async () => {
            const f = fixture();
            f.controls.version = value;
            await assert.rejects(f.run());
            assert.equal(f.executions().length, 1);
        },
    );

for (const failure of ['version-execute', 'verify-execute'])
    test('sanitizes execution failures: ' + failure, async () => {
        const f = fixture();
        f.controls.failure = failure;
        await assert.rejects(f.run(), (error) => {
            assert.equal(String(error), 'Error: Pinned offline verifier execution failed.');
            assert.ok(!String(error).includes('SECRET'));
            assert.ok(!(error as Error).cause);
            return true;
        });
    });

for (const [label, output] of [
    ['empty', Buffer.alloc(0)],
    ['empty array', Buffer.from('[]')],
    ['producer trust Boolean', Buffer.from('{"verified":true}')],
    ['malformed', Buffer.from('[{')],
    ['BOM', Buffer.from('\uFEFF[{}]')],
    ['invalid UTF8', Buffer.from([0xff])],
    ['trailing data', Buffer.from('[{}]x')],
    ['oversize', Buffer.alloc(ATTESTATION_VERIFIER_LIMITS.output + 1)],
    ['too many attestations', Buffer.from(JSON.stringify(Array(65).fill({})))],
    ['duplicate keys', Buffer.from('[{"verificationResult":{},"verificationResult":{}}]')],
    ['escaped duplicate keys', Buffer.from('[{"a":1,"\\u0061":2}]')],
    ['nested duplicate keys', Buffer.from('[{"a":{"x":1,"x":2}}]')],
    ['nested bound', Buffer.from('['.repeat(65) + '0' + ']'.repeat(65))],
] as const)
    test('refuses verifier output ' + label, async () => {
        const f = fixture();
        f.controls.stdout = output;
        await assert.rejects(f.run());
        assert.equal(f.executions().length, 2);
    });

test('JSON strings containing punctuation are not mistaken for duplicate object keys', async () => {
    const f = fixture();
    f.controls.stdout = Buffer.from('[{"a":"x\\\" } [ :","b":{"a":1}},{"a":2}]');
    assert.equal((await f.run()).verificationResults.length, 2);
});

test('malformed output diagnostics never echo fresh verifier stdout', async () => {
    const f = fixture();
    f.controls.stdout = Buffer.from('TOKEN_SECRET invalid JSON');
    await assert.rejects(f.run(), (error) => {
        assert.equal(String(error), 'Error: Malformed verifier JSON output.');
        assert.ok(!(error as Error).cause);
        return true;
    });
});

for (const stage of ['--version', 'attestation'])
    test('rejects config created by verifier after ' + stage, async () => {
        const f = fixture();
        f.controls.onExecute = (args) => {
            if (args[0] === stage) f.controls.configEntries = ['hosts.yml'];
        };
        await assert.rejects(f.run());
        assert.equal(f.executions().length, stage === '--version' ? 1 : 2);
    });

test('unsupported host platform refuses before filesystem or process observations', async () => {
    const f = fixture();
    await assert.rejects(
        verifyLocalAttestation(f.request, { ...f.dependencies, platform: 'win32' }),
    );
    assert.equal(f.calls.length, 0);
});

// A regular descriptor may acknowledge short reads even before all four ELF bytes arrive.
test('short descriptor reads preserve exact verifier ELF identity without weakening digest or close checks', async () => {
    for (const chunk of [1, 2, 3]) {
        const f = fixture();
        f.controls.readChunk = chunk;
        const result = await f.run();
        assert.equal(result.verifier.toolSHA256, f.request.tool.sha256);
        assert.deepEqual(result.subject, {
            kind: 'archive',
            name: 'archive.tar.gz',
            bytes: f.request.subject.bytes,
            sha256: f.request.subject.sha256,
        });
        assert.equal(f.executions().length, 2);
        assert.equal(f.calls.filter((call) => call.operation === 'close').length, 12);
    }
});

test('short descriptor reads cannot admit malformed or truncated executable magic even with matching digest', async () => {
    for (const bytes of [
        Buffer.from([0x7f, 0x45, 0x4c]),
        Buffer.from([0x7f, 0x45, 0x4c, 0x47, 1, 2, 3, 4]),
    ]) {
        for (const chunk of [1, 2, 3]) {
            const f = fixture(),
                tool = f.files.get('/trusted/gh')!;
            tool.bytes = bytes;
            tool.stat.size = bytes.length;
            f.request.tool.sha256 = hash(bytes);
            f.controls.readChunk = chunk;
            await assert.rejects(f.run(), /Verifier stable read or close failed/);
            assert.equal(f.executions().length, 0);
            assert.ok(
                f.calls.some((call) => call.operation === 'close' && call.path === '/trusted/gh'),
            );
        }
    }
});
