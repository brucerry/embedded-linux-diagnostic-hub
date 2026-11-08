import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
    main,
    runWindowsPortablePackage,
    windowsPortableFailure,
    windowsPortableOptions,
} from '../scripts/package-windows-portable.mjs';

const require = createRequire(import.meta.url);
function input() {
    const version = '44.5.1';
    return {
        manifest: { devDependencies: { electron: version } },
        lock: {
            lockfileVersion: 3,
            packages: {
                '': { devDependencies: { electron: version } },
                'node_modules/electron': {
                    version,
                    resolved: `https://registry.npmjs.org/electron/-/electron-${version}.tgz`,
                    integrity: 'sha512-c3ludGhldGlj',
                },
            },
        },
        installed: { name: 'electron', version },
        checksums: {
            [`electron-v${version}-win32-x64.zip`]: 'a'.repeat(64),
            'electron-api.json': 'b'.repeat(64),
            'electron.d.ts': 'c'.repeat(64),
        },
    };
}

test('full installed vendor checksum map is copied into fixed nonpublishing Windows options', () => {
    const f = input();
    const options = windowsPortableOptions(f);
    assert.deepEqual(options, {
        win: ['portable'],
        x64: true,
        publish: 'never',
        config: { electronDownload: { force: false, checksums: f.checksums } },
    });
    assert.notEqual(options.config.electronDownload.checksums, f.checksums);
    f.checksums['electron-api.json'] = 'd'.repeat(64);
    assert.equal(options.config.electronDownload.checksums['electron-api.json'], 'b'.repeat(64));
    const real = {
        manifest: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
        lock: JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')),
        installed: JSON.parse(readFileSync(require.resolve('electron/package.json'), 'utf8')),
        checksums: JSON.parse(readFileSync(require.resolve('electron/checksums.json'), 'utf8')),
    };
    assert.deepEqual(
        windowsPortableOptions(real).config.electronDownload.checksums,
        real.checksums,
    );
});

for (const [label, mutate] of [
    [
        'installed version',
        (f: any) => {
            f.installed.version = '44.5.0';
        },
    ],
    [
        'root version',
        (f: any) => {
            f.manifest.devDependencies.electron = '^44.5.1';
        },
    ],
    [
        'lock root version',
        (f: any) => {
            f.lock.packages[''].devDependencies.electron = '44.5.0';
        },
    ],
    [
        'lock registry',
        (f: any) => {
            f.lock.packages['node_modules/electron'].resolved =
                'https://untrusted.invalid/electron.tgz';
        },
    ],
    [
        'lock integrity',
        (f: any) => {
            f.lock.packages['node_modules/electron'].integrity = '';
        },
    ],
    [
        'missing Windows hash',
        (f: any) => {
            delete f.checksums['electron-v44.5.1-win32-x64.zip'];
        },
    ],
    [
        'invalid non-Windows hash',
        (f: any) => {
            f.checksums['electron-api.json'] = 'not-sha256';
        },
    ],
    [
        'invalid member path',
        (f: any) => {
            f.checksums['../outside'] = 'a'.repeat(64);
        },
    ],
    [
        'empty vendor map',
        (f: any) => {
            f.checksums = {};
        },
    ],
] as const) {
    test('invalid installed/lock/map input refuses before build: ' + label, async () => {
        const f = input();
        mutate(f);
        let builds = 0;
        await assert.rejects(
            runWindowsPortablePackage({
                loadEnvironment: async () => {},
                readInputs: async () => f,
                build: async () => {
                    builds++;
                },
                report: () => {},
            }),
        );
        assert.equal(builds, 0);
    });
}

test('environment loader precedes reads and exactly one fixed builder call; result preserved', async () => {
    const order: string[] = [];
    const result = ['synthetic-portable'];
    assert.equal(
        await runWindowsPortablePackage({
            loadEnvironment: async () => {
                order.push('environment');
            },
            readInputs: async () => {
                order.push('inputs');
                return input();
            },
            build: async (options: any) => {
                order.push('build');
                assert.deepEqual(options, windowsPortableOptions(input()));
                return result;
            },
            report: () => assert.fail('unexpected report'),
        }),
        result,
    );
    assert.deepEqual(order, ['environment', 'inputs', 'build']);
});

test('504 diagnostic cannot expose URL query, credentials, headers, body or error text', async () => {
    const original = Object.assign(Error('SECRET-message'), {
        code: 'ERR_NON_2XX_3XX_RESPONSE',
        options: {
            url: 'https://github.com/electron/electron/releases/download/v44.5.1/SHASUMS256.txt?token=SECRET-query',
            headers: { authorization: 'SECRET-header' },
        },
        response: {
            statusCode: 504,
            url: 'https://SECRET-user:SECRET-password@private.invalid/SECRET-path',
            body: 'SECRET-body',
        },
    });
    const reports: unknown[] = [];
    let calls = 0;
    await assert.rejects(
        runWindowsPortablePackage({
            loadEnvironment: async () => {},
            readInputs: async () => input(),
            build: async () => {
                calls++;
                throw original;
            },
            report: (record: unknown) => {
                reports.push(record);
            },
        }),
        (error: unknown) => error === original,
    );
    assert.equal(calls, 1);
    assert.deepEqual(reports, [
        {
            event: 'windows-portable-package-failure',
            stage: 'build',
            status: 504,
            code: 'ERR_NON_2XX_3XX_RESPONSE',
            artifact: 'electron-checksums',
        },
    ]);
    assert.equal(JSON.stringify(reports).includes('SECRET'), false);
    assert.equal(
        windowsPortableFailure(
            {
                options: {
                    url: 'https://github.com/electron/electron/releases/download/v44.5.1/electron-v44.5.1-win32-x64.zip',
                },
            },
            'build',
        ).artifact,
        'electron-windows-zip',
    );
    assert.deepEqual(
        windowsPortableFailure(
            { code: 'SECRET', response: { statusCode: '504' }, options: { url: 'not-a-url' } },
            'SECRET-stage',
        ),
        {
            event: 'windows-portable-package-failure',
            stage: 'bootstrap',
            status: null,
            code: 'other',
            artifact: 'unknown',
        },
    );
});

test('reporter rejection or throw cannot replace original builder failure', async () => {
    const original = Error('synthetic-primary');
    for (const report of [
        () => {
            throw Error('synthetic-report');
        },
        async () => {
            throw Error('synthetic-report');
        },
    ]) {
        await assert.rejects(
            runWindowsPortablePackage({
                loadEnvironment: async () => {},
                readInputs: async () => input(),
                build: async () => {
                    throw original;
                },
                report,
            }),
            (error: unknown) => error === original,
        );
    }
});

test('diagnostic projection never invokes accessors, proxies or custom URL coercion', () => {
    let effects = 0;
    const getter = () => {
        effects++;
        throw Error('SECRET-getter');
    };
    const unknown = {
        event: 'windows-portable-package-failure',
        stage: 'build',
        status: null,
        code: 'other',
        artifact: 'unknown',
    };
    const accessors = Object.defineProperties(
        {},
        { response: { get: getter }, options: { get: getter }, code: { get: getter } },
    );
    assert.deepEqual(windowsPortableFailure(accessors, 'build'), unknown);
    assert.deepEqual(
        windowsPortableFailure(new Proxy({}, { getOwnPropertyDescriptor: getter }), 'build'),
        unknown,
    );
    assert.deepEqual(
        windowsPortableFailure(
            {
                response: Object.defineProperty({}, 'statusCode', { get: getter }),
                options: { url: { toString: getter, [Symbol.toPrimitive]: getter } },
            },
            'build',
        ),
        unknown,
    );
    assert.deepEqual(
        windowsPortableFailure(
            { options: Object.defineProperty({}, 'url', { get: getter }) },
            'build',
        ),
        unknown,
    );
    assert.deepEqual(
        windowsPortableFailure({ options: { url: new Proxy({}, { get: getter }) } }, 'build'),
        unknown,
    );
    assert.deepEqual(
        windowsPortableFailure({ options: { url: 'x'.repeat(4097) } }, 'build'),
        unknown,
    );
    const nativeURL = new URL(
        'https://github.com/electron/electron/releases/download/v44.5.1/SHASUMS256.txt',
    );
    Object.defineProperty(nativeURL, 'toString', { value: getter });
    assert.equal(
        windowsPortableFailure({ options: { url: nativeURL } }, 'build').artifact,
        'electron-checksums',
    );
    assert.equal(effects, 0);
});

test('main uses injected loader only and reports failure without raw fallback, retaining nonzero exit', async () => {
    const records: unknown[] = [],
        exits: number[] = [];
    let loaded = 0;
    await main({
        load: async () => {
            loaded++;
            return {
                loadEnvironment: async () => {},
                readInputs: async () => input(),
                build: async () => {
                    throw Error('SECRET-build');
                },
            };
        },
        report: (record: unknown) => {
            records.push(record);
        },
        setExitCode: (code: number) => {
            exits.push(code);
        },
    });
    assert.equal(loaded, 1);
    assert.deepEqual(exits, [1]);
    assert.equal(JSON.stringify(records).includes('SECRET'), false);
    await main({
        load: async () => {
            throw Error('SECRET-load');
        },
        report: () => {
            throw Error('SECRET-reporter');
        },
        setExitCode: (code: number) => {
            exits.push(code);
        },
    });
    assert.deepEqual(exits, [1, 1]);
});

function between(source: string, begin: string, end: string) {
    const start = source.indexOf(begin),
        finish = source.indexOf(end);
    assert.ok(start >= 0 && finish > start);
    assert.equal(source.indexOf(begin, start + begin.length), -1);
    assert.equal(source.indexOf(end, finish + end.length), -1);
    return source.slice(start, finish);
}

test('actual locked builder propagates force:false and full vendor map through both option projections', () => {
    const framework = readFileSync(
        require.resolve('app-builder-lib/out/electron/ElectronFramework.js'),
        'utf8',
    );
    const downloader = readFileSync(
        require.resolve('app-builder-lib/out/util/electronGet.js'),
        'utf8',
    );
    // Only these reviewed synchronous option projections execute; no packager/downloader module loads.
    const body =
        between(framework, 'function createDownloadOpts(', 'async function beforeCopyExtraFiles(') +
        between(
            downloader,
            'const ELECTRON_GET_EXCLUSIVE_KEYS =',
            '/**\n * Downloads the electron artifact zip',
        );
    const extract = new Function(
        'resolveCacheMode',
        'builder_util_1',
        body + '; return { createDownloadOpts, buildElectronArtifactConfig };',
    );
    const functions = extract(() => 'synthetic-read-write', {
        log: { warn: () => assert.fail('TLS changed') },
    });
    const f = input(),
        options = windowsPortableOptions(f);
    const download = functions.createDownloadOpts(
        options.config,
        'win32',
        'x64',
        f.installed.version,
    );
    assert.deepEqual(download, {
        platform: 'win32',
        arch: 'x64',
        version: f.installed.version,
        force: false,
        checksums: f.checksums,
    });
    const config = functions.buildElectronArtifactConfig({
        electronDownload: download,
        platformName: 'win32',
        arch: 'x64',
        version: f.installed.version,
        artifactName: 'electron',
    });
    assert.deepEqual(config.checksums, f.checksums);
    assert.equal(config.force, false);
    assert.equal(config.cacheMode, 'synthetic-read-write');
    assert.equal(Object.hasOwn(config, 'unsafelyDisableChecksums'), false);
    assert.equal(Object.hasOwn(config, 'downloadOptions'), false);
    // The same map WITHOUT force falls into the legacy projection and is actually lost.
    const { force: _force, ...withoutDiscriminator } = download;
    assert.equal(
        functions.buildElectronArtifactConfig({
            electronDownload: withoutDiscriminator,
            platformName: 'win32',
            arch: 'x64',
            version: f.installed.version,
            artifactName: 'electron',
        }).checksums,
        undefined,
    );
});

test('actual additive config merger preserves every existing package/signing field', () => {
    const objects = readFileSync(require.resolve('builder-util-runtime/out/objects.js'), 'utf8');
    const configSource = readFileSync(
        require.resolve('app-builder-lib/out/util/config/config.js'),
        'utf8',
    );
    const deepAssign = new Function(
        between(
            objects,
            'function isValidKey(',
            '// Flag names must be letters/digits/hyphens only',
        ) + '; return deepAssign;',
    )();
    const mergePublish = new Function(
        'builder_util_runtime_1',
        between(configSource, 'function mergePublish(', 'async function getConfig(') +
            '; return mergePublish;',
    )({ deepAssign });
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const original = structuredClone(manifest.build);
    original.win.signtoolOptions = {
        signingHashAlgorithms: ['sha256'],
        certificateSubjectName: 'synthetic-subject',
    };
    const config = structuredClone(original);
    const overlay = windowsPortableOptions(input()).config;
    mergePublish(config, overlay);
    const { electronDownload, ...unchanged } = config;
    assert.deepEqual(unchanged, original);
    assert.deepEqual(electronDownload, overlay.electronDownload);
    assert.ok(configSource.includes('mergePublish(config, configFromOptions);'));
});

test('actual entry stays inert on import and both workflow callers retain fixed nonpublishing scope', () => {
    const helper = readFileSync(
        new URL('../scripts/package-windows-portable.mjs', import.meta.url),
        'utf8',
    );
    assert.ok(helper.includes("loadEnv(path.resolve('electron-builder.env'))"));
    assert.match(
        helper,
        /if \(process\.argv\[1\] && path\.resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)\)\s*await main\(\);/,
    );
    assert.equal(helper.includes("from 'electron-builder'"), false);
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(
        manifest.scripts['package:win'],
        'npm run build && node scripts/package-windows-portable.mjs',
    );
    const narrow = readFileSync(
        new URL('../.github/workflows/windows-package-cold-launch.yml', import.meta.url),
        'utf8',
    );
    assert.ok(
        narrow.includes(
            "'package:win': 'npm run build && node scripts/package-windows-portable.mjs'",
        ),
    );
    const shipping = readFileSync(
        new URL('../.github/workflows/windows-portable.yml', import.meta.url),
        'utf8',
    );
    assert.ok(shipping.includes('run: node scripts/package-windows-portable.mjs'));
    assert.equal(shipping.includes('npx electron-builder --win portable'), false);
});
