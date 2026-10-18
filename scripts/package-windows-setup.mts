import { writeWindowsSetupInfo, windowsSetupInfoName } from './lib/windows-setup-release.mjs';
import { renderSetupPresentationNSIS } from '../shared/setup-presentation';
import { readFile, writeFile, readdir, lstat, realpath, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
    validateInstallationManifest,
    INSTALLATION_PRODUCT,
    INSTALLATION_RECORD,
    INSTALLATION_MANIFEST,
} from '../shared/installation';
import {
    SETUP_PAYLOAD,
    SETUP_OWNER,
    SETUP_UNINSTALLER,
} from '../electron/installation-maintenance';

const require = createRequire(import.meta.url);
const tooling = require('app-builder-lib/out/toolsets/windows') as {
    getMakeNsisPath(version?: string): Promise<{ path: string; env?: Record<string, string> }>;
};
const [
    input = 'release/win-unpacked',
    destination = 'release/Diagnostic-Hub-Windows-x64-Setup.exe',
] = process.argv.slice(2);
const root = await realpath(input),
    output = path.resolve(destination);
if (process.platform !== 'win32')
    throw Error('Build and qualify the Windows setup on native Windows.');
if (output.startsWith(root + path.sep) || /["\r\n$]/.test(root + output))
    throw Error('Choose a separate ordinary setup output path.');
const setupDescriptor = path.join(
    path.dirname(output),
    windowsSetupInfoName(path.basename(output)),
);
for (const artifact of [output, output + '.sha256', setupDescriptor]) {
    try {
        await lstat(artifact);
        throw Error('Setup output or sidecar already exists; preserve it and choose fresh output.');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
}
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const files: { kind: 'file'; path: string; bytes: number; sha256: string }[] = [];
let bytes = 0;
async function inventory(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
        if (directory === root && [SETUP_PAYLOAD].includes(name)) continue;
        if (
            directory === root &&
            [INSTALLATION_RECORD, INSTALLATION_MANIFEST, SETUP_OWNER, SETUP_UNINSTALLER].includes(
                name,
            )
        )
            throw Error('A managed installation is not a clean setup build input.');
        const file = path.join(directory, name),
            stat = await lstat(file);
        if (stat.isSymbolicLink()) throw Error('Windows setup input must not contain aliases.');
        if (stat.isDirectory()) await inventory(file);
        else {
            if (!stat.isFile() || stat.nlink !== 1)
                throw Error('Setup input must contain regular files.');
            bytes += stat.size;
            if (bytes > 2 * 1024 ** 3 || files.length >= 20000)
                throw Error('Setup input exceeds its bounds.');
            files.push({
                kind: 'file',
                path: path.relative(root, file).split(path.sep).join('/'),
                bytes: stat.size,
                sha256: createHash('sha256')
                    .update(await readFile(file))
                    .digest('hex'),
            });
        }
    }
}
await inventory(root);
const manifest = validateInstallationManifest({
    schemaVersion: 1,
    product: INSTALLATION_PRODUCT,
    layout: 'windows-nsis',
    platform: 'win32',
    arch: 'x64',
    version,
    sourceCommit,
    entryPoint: 'Diagnostic Hub.exe',
    files,
});
const payloadDescriptor = JSON.stringify(manifest, null, 2);
await writeFile(path.join(root, SETUP_PAYLOAD), payloadDescriptor);
await mkdir(path.dirname(output), { recursive: true });
const presentationInclude = path.join(path.dirname(output), 'setup-action-presentation.nsh');
await writeFile(presentationInclude, renderSetupPresentationNSIS(), { flag: 'wx' });
const compiler = await tooling.getMakeNsisPath();
const args = [
    '/V3',
    '/WX',
    '/DACTION_PRESENTATION=' + presentationInclude,
    '/DPAYLOAD_DIR=' + root,
    '/DSETUP_OUT=' + output,
    '/DAPP_VERSION=' + version,
    '/DFILE_VERSION=' + version.split('-')[0] + '.0',
    path.resolve('build/windows-setup.nsi'),
];
await new Promise<void>((resolve, reject) => {
    const child = spawn(compiler.path, args, {
        env: { ...process.env, ...compiler.env },
        stdio: 'inherit',
        windowsHide: true,
        shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code) =>
        code === 0 ? resolve() : reject(Error('NSIS compiler exited ' + code)),
    );
});
const payloadManifestSHA256 = createHash('sha256').update(payloadDescriptor).digest('hex');
const { info, descriptor } = await writeWindowsSetupInfo(output, {
    version,
    commit: sourceCommit,
    payloadManifestSHA256,
});
console.log(
    JSON.stringify({
        file: output,
        sha256: info.sha256,
        descriptor,
        payloadManifestSHA256,
        version,
        sourceCommit,
        payloadFiles: files.length,
        payloadBytes: bytes,
        published: false,
        publisherSignature: 'not claimed',
    }),
);
