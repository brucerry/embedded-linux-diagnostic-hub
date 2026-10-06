import { readFile, writeFile, mkdtemp, mkdir, cp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = process.cwd();
const source = JSON.parse(await readFile('package.json', 'utf8'));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const staged = await mkdtemp(path.join(tmpdir(), 'diagnostic-hub-gateway-'));
try {
    const manifest = {
        name: `${source.name}-gateway`,
        version: source.version,
        private: true,
        license: 'MIT',
        main: 'dist-gateway/main.cjs',
        engines: { node: '>=24' },
        scripts: { start: 'node --env-file=.env.gateway dist-gateway/main.cjs' },
        dependencies: { ssh2: lock.packages['node_modules/ssh2'].version },
    };
    await writeFile(path.join(staged, 'package.json'), JSON.stringify(manifest, null, 2));
    lock.name = manifest.name;
    lock.packages[''] = {
        name: manifest.name,
        version: manifest.version,
        license: 'MIT',
        dependencies: manifest.dependencies,
        engines: manifest.engines,
    };
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
    const destination = path.join(
        root,
        'release',
        `Diagnostic-Hub-Gateway-${source.version}.tar.gz`,
    );
    await mkdir(path.dirname(destination), { recursive: true });
    const archive = spawnSync('tar', ['-czf', destination, '-C', staged, '.'], {
        encoding: 'utf8',
    });
    if (archive.status !== 0) throw new Error(`Could not archive the gateway: ${archive.stderr}`);
    console.log(`Gateway package: ${destination}`);
} finally {
    await rm(staged, { recursive: true, force: true });
}
