import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';

/** Use the vendor map installed by npm ci, rather than a second remote checksum fetch. */
export function windowsPortableOptions({ manifest, lock, installed, checksums }) {
    const selected = lock?.packages?.['node_modules/electron'];
    const version = selected?.version;
    assert.equal(typeof version, 'string');
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.equal(lock.lockfileVersion, 3);
    assert.equal(manifest.devDependencies?.electron, version);
    assert.equal(lock.packages['']?.devDependencies?.electron, version);
    assert.equal(
        selected.resolved,
        `https://registry.npmjs.org/electron/-/electron-${version}.tgz`,
    );
    assert.match(selected.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    assert.equal(installed?.name, 'electron');
    assert.equal(installed.version, version);
    assert.ok(checksums && typeof checksums === 'object' && !Array.isArray(checksums));
    assert.equal(Object.getPrototypeOf(checksums), Object.prototype);
    const entries = Object.entries(checksums);
    assert.ok(entries.length > 0 && entries.length <= 256);
    for (const [name, sha256] of entries) {
        assert.ok(name.length <= 192 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name));
        assert.equal(typeof sha256, 'string');
        assert.match(sha256, /^[a-f0-9]{64}$/);
    }
    assert.ok(Object.hasOwn(checksums, `electron-v${version}-win32-x64.zip`));
    return {
        win: ['portable'],
        x64: true,
        publish: 'never',
        // Own force:false selects the supported Get options path without forcing a download.
        // Do not add mirrorOptions: createDownloadOpts would discard the checksum map.
        config: { electronDownload: { force: false, checksums: Object.fromEntries(entries) } },
    };
}

const knownCodes = new Set([
    'ERR_NON_2XX_3XX_RESPONSE',
    'ENOTFOUND',
    'ETIMEDOUT',
    'ECONNRESET',
    'EPIPE',
    'ENOENT',
]);

/** Only finite categories leave this boundary; no URLs, messages, stacks or request options. */
export function windowsPortableFailure(error, stage) {
    let status = null;
    let code = 'other';
    let artifact = 'unknown';
    try {
        const data = (object, key) => {
            if (!object || typeof object !== 'object' || types.isProxy(object)) return undefined;
            const descriptor = Object.getOwnPropertyDescriptor(object, key);
            return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
        };
        const candidate = data(data(error, 'response'), 'statusCode');
        if (Number.isInteger(candidate) && candidate >= 100 && candidate <= 599) status = candidate;
        const candidateCode = data(error, 'code');
        if (knownCodes.has(candidateCode)) code = candidateCode;
        const candidateURL = data(data(error, 'options'), 'url');
        if (
            typeof candidateURL !== 'string' &&
            (!candidateURL || typeof candidateURL !== 'object' || types.isProxy(candidateURL))
        )
            throw Error('Unavailable URL metadata.');
        const text =
            typeof candidateURL === 'string'
                ? candidateURL
                : URL.prototype.toString.call(candidateURL);
        if (text.length > 4096) throw Error('URL metadata exceeds its bound.');
        const url = new URL(text);
        if (
            url.protocol === 'https:' &&
            url.hostname === 'github.com' &&
            !url.username &&
            !url.password
        ) {
            if (
                /^\/electron\/electron\/releases\/download\/v\d+\.\d+\.\d+\/SHASUMS256\.txt$/.test(
                    url.pathname,
                )
            )
                artifact = 'electron-checksums';
            else if (
                /^\/electron\/electron\/releases\/download\/v\d+\.\d+\.\d+\/electron-v\d+\.\d+\.\d+-win32-x64\.zip$/.test(
                    url.pathname,
                )
            )
                artifact = 'electron-windows-zip';
        }
    } catch {
        // Malformed or unavailable error metadata adds no authority or raw fallback.
    }
    return {
        event: 'windows-portable-package-failure',
        stage: ['environment', 'inputs', 'build'].includes(stage) ? stage : 'bootstrap',
        status,
        code,
        artifact,
    };
}

/** All effects are explicit ports; rejection identity survives reporting failure. */
export async function runWindowsPortablePackage({ loadEnvironment, readInputs, build, report }) {
    let stage = 'environment';
    try {
        await loadEnvironment();
        stage = 'inputs';
        const options = windowsPortableOptions(await readInputs());
        stage = 'build';
        return await build(options);
    } catch (error) {
        try {
            await report(windowsPortableFailure(error, stage));
        } catch {
            /* Preserve primary error. */
        }
        throw error;
    }
}

async function nativePorts() {
    const { readFile } = await import('node:fs/promises');
    const { loadEnv } = await import('app-builder-lib/out/util/config/load.js');
    const { build } = await import('electron-builder');
    const readJSON = async (file) => JSON.parse(await readFile(file, 'utf8'));
    return {
        loadEnvironment: () => loadEnv(path.resolve('electron-builder.env')),
        readInputs: async () => {
            const [manifest, lock, installed, checksums] = await Promise.all([
                readJSON(path.resolve('package.json')),
                readJSON(path.resolve('package-lock.json')),
                readJSON(new URL('../node_modules/electron/package.json', import.meta.url)),
                readJSON(new URL('../node_modules/electron/checksums.json', import.meta.url)),
            ]);
            return { manifest, lock, installed, checksums };
        },
        build,
    };
}

export async function main({
    load = nativePorts,
    report = (record) =>
        console.error(
            (process.env.GITHUB_ACTIONS === 'true'
                ? '::error title=Windows portable package::'
                : '') + JSON.stringify(record),
        ),
    setExitCode = (code) => {
        process.exitCode = code;
        process.on('exit', () => {
            process.exitCode = code;
        });
    },
} = {}) {
    let entered = false;
    try {
        const ports = await load();
        entered = true;
        await runWindowsPortablePackage({ ...ports, report });
    } catch (error) {
        if (!entered) {
            try {
                await report(windowsPortableFailure(error, 'bootstrap'));
            } catch {
                /* Nonzero still required. */
            }
        }
        setExitCode(1);
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    void main().catch(() => {
        process.exitCode = 1;
    });
