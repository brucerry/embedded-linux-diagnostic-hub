import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { boundedRead } from './product-collector-evidence.mjs';
import { dependencyFacts } from './windows-preflight.mjs';
/** Presence-only preparation. Never import Electron's lazy index or start its installer. */
export function settledElectronExecutable(root, environment = process.env) {
    for (const key of [
        'ELECTRON_OVERRIDE_DIST_PATH',
        'ELECTRON_INSTALL_PLATFORM',
        'ELECTRON_INSTALL_ARCH',
    ])
        assert(!environment[key], 'Unreviewed Electron dependency override: ' + key);
    const require = createRequire(path.join(root, 'package.json')),
        pkg = require.resolve('electron/package.json'),
        dir = path.dirname(pkg);
    assert.equal(JSON.parse(boundedRead(pkg, 65536).toString('utf8')).version, '44.5.1');
    const small = (file) => {
        const s = fs.lstatSync(file);
        assert(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= 128);
        return boundedRead(file, 128).toString('utf8');
    };
    const relative = small(path.join(dir, 'path.txt'));
    assert.equal(
        relative,
        'electron.exe',
        'Settled Windows Electron path.txt required; no bootstrap during enrollment.',
    );
    assert.equal(small(path.join(dir, 'dist/version')).trim().replace(/^v/, ''), '44.5.1');
    const executable = path.join(dir, 'dist', relative),
        s = fs.lstatSync(executable);
    assert(
        s.isFile() &&
            !s.isSymbolicLink() &&
            s.size > 0 &&
            s.size <= 2147483648 &&
            fs.realpathSync(executable) === executable,
        'Settled pinned Electron executable required.',
    );
    return executable;
}
export function prepareAndFreezePilotDependencies(
    root,
    {
        environment = process.env,
        check = () => {},
        record = () => {},
        resolve = settledElectronExecutable,
        freeze = dependencyFacts,
    } = {},
) {
    check();
    const electron = resolve(root, environment);
    assert(typeof electron === 'string' && path.isAbsolute(electron));
    check();
    record('electron-dependency-settled', {
        path: electron,
        version: '44.5.1',
        hiddenBootstrapAllowed: false,
        preparation: 'verify-existing-or-fail-missing',
    });
    const dependencies = freeze(path.join(root, 'node_modules'), check, {
        contentPartitions: true,
    });
    check();
    record('dependency-identity-frozen', dependencies);
    return { electron, dependencies };
}
/** PTY dependencies are inventoried without resolving, preparing or probing Electron. */
export function freezePtyObservationDependencies(
    root,
    { check = () => {}, record = () => {}, freeze = dependencyFacts } = {},
) {
    check();
    const dependencies = freeze(path.join(root, 'node_modules'), check, {
        contentPartitions: true,
    });
    check();
    record('pty-dependency-identity-frozen', dependencies);
    return { dependencies };
}
