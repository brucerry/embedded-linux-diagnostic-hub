import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
    queryRuntimeImages,
    selectQueryRuntime,
    requireQueryRuntimeSelection,
    queryRuntimePaths,
    requireKnownQueryRuntime,
} from '../scripts/lib/security-query-runtime-selection.mjs';
import {
    requirePreinstalledQueryRuntime,
    requireBoundQueryRuntime,
    queryRuntimeAdmissionReceipt,
    queryJobLimits,
} from '../scripts/lib/security-query-job-admission.mjs';
import { queryHostedContext } from '../scripts/lib/security-query-diagnostic.mjs';

// Explicit single-file, injected-data tests. No child fixtures, runtime entry import,
// live environment access/mutation, filesystem mutation, real network or timers.
const cache = 'C:\\hostedtoolcache\\windows';
const environment = (row) => ({
    ImageOS: row.imageOS,
    ImageVersion: row.imageVersion,
    RUNNER_OS: 'Windows',
    RUNNER_ARCH: 'X64',
    RUNNER_TOOL_CACHE: cache,
});
function fixture(row, fault = '') {
    const paths = queryRuntimePaths(row, cache),
        calls = [];
    const io = {
        lstatSync(p) {
            calls.push(['lstat', p]);
            if (
                (fault === 'missing-exe' && p === paths.executable) ||
                (fault === 'missing-marker' && p === paths.completeMarker) ||
                (fault === 'missing-version' && p.endsWith(row.node.slice(1)))
            )
                throw Error('fixture missing');
            const file = p === paths.executable || p === paths.completeMarker;
            return {
                isDirectory: () => !file && fault !== 'ancestor-file',
                isFile: () => file && fault !== 'not-file',
                isSymbolicLink: () => fault === 'symlink',
                nlink: fault === 'hardlink' ? 2 : 1,
                size: p === paths.completeMarker ? (fault === 'incomplete' ? 1 : 0) : 100,
            };
        },
        realpathSync(p) {
            calls.push(['realpath', p]);
            return fault === 'alias' ? p + '-alias' : p;
        },
    };
    return {
        env: environment(row),
        options: {
            platform: 'win32',
            arch: 'x64',
            version: row.node,
            execPath: paths.executable,
            io,
        },
        calls,
        paths,
    };
}
test('exact two immutable image tuples match reviewed policy and manifest identities', () => {
    assert.deepEqual(queryRuntimeImages, [
        {
            imageOS: 'win25-vs2026',
            imageVersion: '20261007.264.1',
            node: 'v24.21.0',
            arch: 'x64',
            manifestCommit: 'aee0669dd04510a11756664eb77f5630debabed3',
        },
        {
            imageOS: 'win25-vs2026',
            imageVersion: '20261018.275.1',
            node: 'v24.22.0',
            arch: 'x64',
            manifestCommit: '5fd1e8a2974fa507db165974a2acad9e4f7bf677',
        },
    ]);
    assert(Object.isFrozen(queryRuntimeImages));
    for (const row of queryRuntimeImages) assert(Object.isFrozen(row));
});
for (const row of queryRuntimeImages) {
    test('selected exact runtime admits owner and bound leaf: ' + row.imageVersion, () => {
        const f = fixture(row),
            before = JSON.stringify(f.env),
            selected = selectQueryRuntime(f.env);
        assert.equal(selected, row);
        const admission = requirePreinstalledQueryRuntime(f.env, f.options);
        assert.deepEqual(admission.selection, row);
        assert.equal(admission.version, row.node);
        assert.equal(admission.installation, false);
        assert.equal(admission.fallback, false);
        const transported = JSON.parse(JSON.stringify(admission));
        assert.doesNotThrow(() => requireBoundQueryRuntime(transported, f.options));
        const receipt = JSON.parse(queryRuntimeAdmissionReceipt(admission));
        assert.deepEqual(receipt.selection, row);
        assert.equal(receipt.jobAdmitted, false);
        assert.equal(receipt.queryAdmitted, false);
        assert.equal(receipt.closureAttested, false);
        assert(Buffer.byteLength(queryRuntimeAdmissionReceipt(admission)) <= 4096);
        assert.equal(JSON.stringify(f.env), before);
        const other = queryRuntimeImages.find((x) => x !== row).node.slice(1);
        assert(f.calls.every(([, p]) => !p.includes('\\' + other + '\\')));
    });
    for (const fault of [
        'missing-exe',
        'missing-marker',
        'missing-version',
        'incomplete',
        'symlink',
        'alias',
        'hardlink',
        'ancestor-file',
        'not-file',
    ]) {
        test(
            'selected ' + row.imageVersion + ' refuses ' + fault + ' without inspecting alternate',
            () => {
                const f = fixture(row, fault),
                    other = queryRuntimeImages.find((x) => x !== row).node.slice(1);
                assert.throws(() => requirePreinstalledQueryRuntime(f.env, f.options));
                assert(f.calls.every(([, p]) => !p.includes('\\' + other + '\\')));
            },
        );
    }
    for (const version of [
        'v24.20.0',
        'v24.21.1',
        'v24.22.1',
        'v24.23.0',
        queryRuntimeImages.find((x) => x !== row).node,
    ]) {
        test(
            'image ' + row.imageVersion + ' wrong process version refuses before IO: ' + version,
            () => {
                const f = fixture(row);
                assert.throws(() =>
                    requirePreinstalledQueryRuntime(f.env, { ...f.options, version }),
                );
                assert.equal(f.calls.length, 0);
            },
        );
    }
    for (const patch of [
        { platform: 'darwin' },
        { arch: 'arm64' },
        { execPath: 'C:\\other\\node.exe' },
        {
            execPath: queryRuntimePaths(
                queryRuntimeImages.find((x) => x !== row),
                cache,
            ).executable,
        },
    ]) {
        test(
            'image ' +
                row.imageVersion +
                ' wrong process tuple refuses before IO ' +
                JSON.stringify(patch),
            () => {
                const f = fixture(row);
                assert.throws(() =>
                    requirePreinstalledQueryRuntime(f.env, { ...f.options, ...patch }),
                );
                assert.equal(f.calls.length, 0);
            },
        );
    }
    for (const key of [
        'selection',
        'version',
        'platform',
        'arch',
        'executable',
        'completeMarker',
        'toolCache',
        'kind',
        'installation',
        'fallback',
    ]) {
        test(
            'bound leaf refuses altered owner runtime field ' + row.imageVersion + '/' + key,
            () => {
                const f = fixture(row),
                    a = JSON.parse(
                        JSON.stringify(requirePreinstalledQueryRuntime(f.env, f.options)),
                    );
                a[key] =
                    key === 'selection'
                        ? queryRuntimeImages.find((x) => x !== row)
                        : key === 'installation' || key === 'fallback'
                          ? true
                          : 'wrong';
                f.calls.length = 0;
                assert.throws(() => requireBoundQueryRuntime(a, f.options));
                assert.equal(f.calls.length, 0);
            },
        );
    }
    test(
        'bound leaf checks actual own version and cache closure prerequisites ' + row.imageVersion,
        () => {
            const f = fixture(row),
                a = requirePreinstalledQueryRuntime(f.env, f.options);
            for (const other of queryRuntimeImages.filter((x) => x !== row))
                assert.throws(() =>
                    requireBoundQueryRuntime(a, { ...f.options, version: other.node }),
                );
            assert.throws(() =>
                requireBoundQueryRuntime(a, fixture(row, 'missing-marker').options),
            );
            assert.throws(() => queryRuntimeAdmissionReceipt({ ...a }));
            assert.throws(() => requireBoundQueryRuntime({ ...a, extra: 'unreviewed' }, f.options));
        },
    );
}
for (const key of ['ImageOS', 'ImageVersion', 'RUNNER_OS', 'RUNNER_ARCH']) {
    for (const bad of [
        undefined,
        null,
        '',
        false,
        24,
        [],
        {},
        'unknown',
        'WIN25-VS2026',
        '20261018.275.1 ',
        '20261007.264.2',
        '20261018.275.１',
        'SECRET" & echo SECRET',
        'SECRET\nSECRET',
        'SECRET!PATH!%PATH%',
    ]) {
        test('metadata refuses malformed ' + key + '/' + JSON.stringify(bad), () => {
            const f = fixture(queryRuntimeImages[0]);
            f.env[key] = bad;
            let error;
            try {
                requirePreinstalledQueryRuntime(f.env, f.options);
            } catch (e) {
                error = e;
            }
            assert(error);
            assert(!String(error).includes('SECRET'));
            assert.equal(f.calls.length, 0);
        });
    }
    test('metadata missing/accessor/duplicate/case-fold ambiguity refuses ' + key, () => {
        const f = fixture(queryRuntimeImages[0]);
        delete f.env[key];
        assert.throws(() => selectQueryRuntime(f.env));
        let reads = 0;
        Object.defineProperty(f.env, key, {
            configurable: true,
            enumerable: true,
            get() {
                reads++;
                return 'SECRET';
            },
        });
        assert.throws(() => selectQueryRuntime(f.env));
        assert.equal(reads, 0);
        const original = environment(queryRuntimeImages[0]);
        original[key.toLowerCase()] = original[key];
        assert.throws(() => selectQueryRuntime(original));
        delete original[key];
        assert.throws(() => selectQueryRuntime(original));
    });
}
test('unknown image refuses even if both fixed runtimes would exist; no IO or discovery', () => {
    const f = fixture(queryRuntimeImages[1]);
    f.env.ImageVersion = '20261021.999.1';
    assert.throws(() => requirePreinstalledQueryRuntime(f.env, f.options));
    assert.equal(f.calls.length, 0);
});
for (const row of queryRuntimeImages) {
    test(
        'host binding pins the selected image metadata without rebinding: ' + row.imageVersion,
        () => {
            const env = {
                ...environment(row),
                GITHUB_ACTIONS: 'true',
                RUNNER_ENVIRONMENT: 'github-hosted',
                GITHUB_REPOSITORY: 'brucerry/embedded-linux-diagnostic-hub',
                GITHUB_EVENT_NAME: 'workflow_dispatch',
                GITHUB_ACTOR: 'brucerry',
                GITHUB_TRIGGERING_ACTOR: 'brucerry',
                GITHUB_RUN_ATTEMPT: '1',
                GITHUB_RUN_ID: '123',
                HUB_WINDOWS_SECURITY_QUERY_ONLY: '1',
                SystemRoot: 'C:\\Windows',
                USERPROFILE: 'C:\\Users\\runner',
                TEMP: 'C:\\Users\\runner\\AppData\\Local\\Temp',
                TMP: 'C:\\Users\\runner\\AppData\\Local\\Temp',
                LOCALAPPDATA: 'C:\\Users\\runner\\AppData\\Local',
            };
            const options = {
                platform: 'win32',
                arch: 'x64',
                version: row.node,
                tmp: env.TEMP,
                bind: (p) => ({ path: p, check() {} }),
            };
            const context = queryHostedContext(env, options);
            assert.doesNotThrow(() => context.check());
            env.ImageVersion = queryRuntimeImages.find((x) => x !== row).imageVersion;
            assert.throws(() => context.check());
            assert.throws(() => queryHostedContext(env, options));
            env.ImageVersion = 'SECRET';
            let binds = 0;
            assert.throws(
                () =>
                    queryHostedContext(env, {
                        ...options,
                        bind() {
                            binds++;
                        },
                    }),
                (error) => !String(error).includes('SECRET'),
            );
            assert.equal(binds, 0);
        },
    );
}
test('data-only bootstrap predicate rejects malformed/partial/repeated metadata; owner retains exact case authority', () => {
    const matches = (value, literal) =>
        typeof value === 'string' &&
        value.length === literal.length &&
        value.toLowerCase().split(literal.toLowerCase()).join('') === '';
    for (const literal of ['Windows', 'X64', 'win25-vs2026', '20261007.264.1', '20261018.275.1']) {
        assert(matches(literal, literal));
        for (const bad of [
            '',
            literal.slice(1),
            literal + literal,
            literal + ' ',
            ' ' + literal,
            literal + '" & echo SECRET',
            '\n' + literal,
            literal + '!PATH!',
            literal + '%PATH%',
            literal + '\u0000',
        ])
            assert(!matches(bad, literal));
    }
    for (const key of ['ImageOS', 'RUNNER_OS', 'RUNNER_ARCH']) {
        const env = environment(queryRuntimeImages[0]);
        env[key] = env[key].toLowerCase();
        if (env[key] !== environment(queryRuntimeImages[0])[key])
            assert.throws(() => selectQueryRuntime(env));
    }
});
test('selection fields reject tampered manifest, extra secret fields and getters without value disclosure', () => {
    for (const v of [
        null,
        false,
        {},
        { ...queryRuntimeImages[0], manifestCommit: 'SECRET' },
        { ...queryRuntimeImages[0], extra: 'SECRET' },
    ]) {
        assert.throws(
            () => requireQueryRuntimeSelection(v),
            (error) => !String(error).includes('SECRET'),
        );
    }
    let reads = 0;
    const v = { ...queryRuntimeImages[0] };
    Object.defineProperty(v, 'imageOS', {
        get() {
            reads++;
            return 'SECRET';
        },
    });
    assert.throws(() => requireQueryRuntimeSelection(v));
    assert.equal(reads, 0);
});
test('leaf rejects unreviewed runtime before reading its binding; this precheck grants no selection', () => {
    for (const row of queryRuntimeImages)
        assert.equal(requireKnownQueryRuntime(row.node, 'win32', 'x64'), undefined);
    for (const args of [
        ['v24.23.0', 'win32', 'x64'],
        ['v24.21.0', 'darwin', 'x64'],
        ['v24.22.0', 'win32', 'arm64'],
    ])
        assert.throws(() => requireKnownQueryRuntime(...args));
});
test('workflow selector has the same finite rows, one launch, fail-closed components and unchanged non-query jobs', () => {
    const text = readFileSync(
        new URL('../.github/workflows/windows-portable.yml', import.meta.url),
        'utf8',
    );
    const [prefix, body] = text.split('    windows-security-query-only:');
    assert.equal(
        createHash('sha256').update(prefix).digest('hex'),
        '50d6d49782be5a408d33e3065ce84f1a6eb55df8d04e05b740e57078447df657',
    );
    const images = [
        ...body.matchAll(/set "SECURITY_QUERY_META_REMAINDER=!ImageVersion:([0-9.]+)=!"/g),
    ].map((m) => m[1]);
    const versions = [
        ...body.matchAll(
            /if defined SECURITY_QUERY_IMAGE_(OLD|NEW) set "SECURITY_QUERY_NODE_VERSION=([0-9.]+)"/g,
        ),
    ].map((m) => 'v' + m[2]);
    assert.deepEqual(
        images,
        queryRuntimeImages.map((r) => r.imageVersion),
    );
    assert.deepEqual(
        versions,
        queryRuntimeImages.map((r) => r.node),
    );
    for (const [key, value] of [
        ['RUNNER_OS', 'Windows'],
        ['RUNNER_ARCH', 'X64'],
        ['ImageOS', 'win25-vs2026'],
    ]) {
        assert(body.includes('set "SECURITY_QUERY_META_REMAINDER=!' + key + ':' + value + '=!"'));
        assert(
            body.includes(
                'set "SECURITY_QUERY_META_REMAINDER=!' + key + ':~' + value.length + '!"',
            ),
        );
        assert(body.includes('if not defined ' + key + ' ('));
    }
    assert.doesNotMatch(body, /if[^\r\n]*!(?:ImageOS|ImageVersion|RUNNER_OS|RUNNER_ARCH)[^!]*!/i);
    assert.doesNotMatch(body, /echo[^\r\n]*!(?:ImageOS|ImageVersion|RUNNER_OS|RUNNER_ARCH)[^!]*!/i);
    assert.match(body, /setlocal EnableExtensions EnableDelayedExpansion/);
    assert.match(body, /set "SECURITY_QUERY_NODE_VERSION="/);
    // Preserve eight executed component rows on success; unknown image exits with
    // one fixed refusal before component checks. Selection is in the owner receipt.
    assert.doesNotMatch(body, /"kind":"query-runtime-selection","reviewed":true/);
    assert.match(body, /if not defined SECURITY_QUERY_NODE_VERSION \(\s+echo [^\n]+\s+exit \/b 1/);
    assert.equal(
        (
            body.match(
                /node\.exe" --experimental-transform-types scripts\/windows-security-query-diagnostic\.mjs/g,
            ) ?? []
        ).length,
        1,
    );
    assert.doesNotMatch(
        body,
        /%ImageOS%|%ImageVersion%|%RUNNER_OS%|%RUNNER_ARCH%|setup-node|\bcall\b|\bgoto\b|\bfor\b|powershell|Invoke-WebRequest|curl|\bnpm\b|\bnpx\b|--version/i,
    );
    for (const component of [
        'cache-base',
        'node-tool',
        'selected-version',
        'arch-x64',
        'node-exe-path',
        'complete-marker-path',
        'entry-script-path',
    ]) {
        assert(
            body.includes(
                '"component":"' +
                    component +
                    '","pathExists":false}\n                    exit /b 1',
            ),
        );
    }
    assert.match(body, /timeout-minutes: 15/);
    assert.match(body, /contents: read/);
});
test('integration preserves leaf allowlist, owner normalization and runtime binding before ready', () => {
    const runtime = readFileSync(
        new URL('../scripts/lib/security-query-diagnostic-runtime.mjs', import.meta.url),
        'utf8',
    );
    const leaf = runtime.slice(runtime.indexOf('export async function queryLeaf'));
    assert(leaf.indexOf('requireKnownQueryRuntime(') < leaf.indexOf('readEvidenceProof('));
    assert(runtime.includes('runtimeAdmission,\n            ps,'));
    assert(
        leaf.indexOf('requireBoundQueryRuntime(b.runtimeAdmission)') <
            leaf.indexOf("kind: 'query-ready'"),
    );
    assert(leaf.includes('assert.equal(b.runtimeAdmission.executable, b.node.path'));
    assert.equal((runtime.match(/normalizeQueryOwnerEnvironment\(/g) ?? []).length, 1);
    assert.deepEqual(queryJobLimits, {
        outerMs: 900000,
        ownerMs: 600000,
        retentionPostMs: 120000,
        metadataMs: 10000,
        metadataBytes: 65536,
        clockSlackMs: 2000,
    });
});
