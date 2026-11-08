import * as filesystem from 'node:fs/promises';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    GATEWAY_PAYLOAD_FILES,
    projectGatewayLock,
    validatePreparedGatewayLock,
} from './lib/gateway-lock-plan.mjs';
import { encodeGatewayTar, inspectOwnedGatewayTar } from './lib/gateway-tar.mjs';
import { readStableArtifactFile } from './lib/stable-artifact-file.mjs';
import { WEB_ARCHIVE_LIMITS } from './lib/web-archive-limits.mjs';

const { readFile, writeFile, mkdtemp, mkdir, cp, rm } = filesystem;

const root = process.cwd();
const source = JSON.parse(await readFile('package.json', 'utf8'));
const sourceLock = JSON.parse(await readFile('package-lock.json', 'utf8'));
// Admit the committed closure before staging; npm may normalize this projection,
// but must not introduce new identities or unrelated source dependencies.
const { manifest, lock } = projectGatewayLock(source, sourceLock);
const staged = await mkdtemp(path.join(tmpdir(), 'diagnostic-hub-gateway-'));
try {
    await writeFile(path.join(staged, 'package.json'), JSON.stringify(manifest, null, 2));
    await writeFile(path.join(staged, 'package-lock.json'), JSON.stringify(lock, null, 2));
    for (const file of [
        'dist-gateway',
        '.env.gateway.example',
        'LICENSE',
        'gateway/Caddyfile.example',
        'docs/gateway.md',
    ]) {
        const destination = path.join(staged, file);
        await mkdir(path.dirname(destination), { recursive: true });
        await cp(file, destination, { recursive: true });
    }
    await writeFile(
        path.join(staged, 'README.md'),
        '# Diagnostic Hub lab gateway\n\nSee docs/gateway.md for setup. Install Node.js 24, then run:\n\n```sh\nnpm ci --omit=optional --ignore-scripts\ncp .env.gateway.example .env.gateway\n# Set a random token, website origin, device addresses and verified host fingerprints.\nnpm start\n```\n\nExpose this service through a trusted HTTPS reverse proxy. The portable desktop application connects directly and does not require this gateway.\n',
    );
    const npm = spawnSync(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        [
            'install',
            '--package-lock-only',
            '--ignore-scripts',
            '--omit=optional',
            '--no-audit',
            '--no-fund',
        ],
        { cwd: staged, encoding: 'utf8', shell: process.platform === 'win32' },
    );
    if (npm.status !== 0)
        throw new Error(`Could not prepare gateway dependency lock: ${npm.stderr}`);
    // Check the actual npm result before archive publication. A zero
    // exit alone cannot prove that package versions, URLs or integrities stayed pinned.
    const files = new Map();
    let payloadBytes = 0;
    for (const name of GATEWAY_PAYLOAD_FILES) {
        const { bytes } = await readStableArtifactFile(
            staged,
            name,
            WEB_ARCHIVE_LIMITS.member,
            filesystem,
        );
        payloadBytes += bytes.length;
        assert.ok(payloadBytes <= WEB_ARCHIVE_LIMITS.expanded);
        files.set(name, bytes);
    }
    assert.deepEqual(JSON.parse(files.get('package.json').toString('utf8')), manifest);
    validatePreparedGatewayLock(
        JSON.parse(files.get('package-lock.json').toString('utf8')),
        manifest,
        sourceLock,
    );
    const destination = path.join(
        root,
        'release',
        `Diagnostic-Hub-Gateway-${source.version}.tar.gz`,
    );
    await mkdir(path.dirname(destination), { recursive: true });
    // Share the producer's exact eight-file, normalized USTAR layout. GNU tar's
    // default headers, root entry and record padding do not satisfy this contract.
    const raw = encodeGatewayTar(files);
    inspectOwnedGatewayTar(raw, files);
    const archive = gzipSync(raw, { level: 9, maxOutputLength: WEB_ARCHIVE_LIMITS.archive });
    await writeFile(destination, archive);
    console.log(`Gateway package: ${destination}`);
} finally {
    await rm(staged, { recursive: true, force: true });
}
