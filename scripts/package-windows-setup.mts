import {
    assertWindowsSetupOutput,
    inventoryWindowsSetupInput,
    writeSetupPayloadDescriptor,
    revalidateWindowsSetupInput,
} from './lib/windows-setup-input.mjs';
import { extractFile } from '@electron/asar';
import {
    writeWindowsSetupInfo,
    windowsSetupInfoName,
    validateWindowsPayloadPackage,
} from './lib/windows-setup-release.mjs';
import { renderSetupPresentationNSIS } from '../shared/setup-presentation';
import { readFile, writeFile, lstat, realpath, mkdir } from 'node:fs/promises';
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
assertWindowsSetupOutput(root, output);
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
const reservedNames = [
    SETUP_PAYLOAD,
    INSTALLATION_RECORD,
    INSTALLATION_MANIFEST,
    SETUP_OWNER,
    SETUP_UNINSTALLER,
];
const initialInventory = await inventoryWindowsSetupInput(root, { reservedNames });
const { files, bytes } = initialInventory;
// Inspect the packaged app itself before writing labels or invoking the compiler.
// This detects stale/wrong product/version; it does not authenticate build/source provenance.
validateWindowsPayloadPackage(
    extractFile(path.join(root, 'resources', 'app.asar'), 'package.json'),
    version,
);

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
const ownDescriptor = await writeSetupPayloadDescriptor(root, SETUP_PAYLOAD, payloadDescriptor);
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
await revalidateWindowsSetupInput(root, initialInventory, { reservedNames, ownDescriptor });
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
