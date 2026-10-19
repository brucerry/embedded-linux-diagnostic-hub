import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ancestryIdentity, checkAncestry } from '../../scripts/lib/windows-preflight.mjs';
import {
    nativeReadinessMode,
    ptyObservationMode,
} from '../../scripts/lib/hosted-pilot-contract.mjs';
export function pilotPathMap(
    root: string,
    nonce: string,
    create = false,
    mode = nativeReadinessMode,
) {
    assert([nativeReadinessMode, ptyObservationMode].includes(mode));
    assert(path.isAbsolute(root) && fs.realpathSync(root) === root);
    assert.equal(path.basename(root), 'diagnostic-hub-native-pilot-' + nonce);
    const ancestry = ancestryIdentity(root);
    const paths = Object.fromEntries(
        Object.entries({
            ptyHomeParent: 'pty-home',
            runtimeParent: 'ssh-runtime',
            ptyJournalParent: 'pty-journal',
            profile: 'native-profile',
            artifactsDir: 'playwright-artifacts',
            tracesDir: 'playwright-traces',
            temp: 'native-temp',
            crash: 'native-crash',
            logs: 'native-logs',
        })
            .filter(
                ([key]) =>
                    mode !== ptyObservationMode ||
                    ['ptyHomeParent', 'runtimeParent', 'ptyJournalParent'].includes(key),
            )
            .map(([key, leaf]) => [key, path.join(root, leaf)]),
    ) as Record<string, string>;
    if (create) for (const dir of Object.values(paths)) fs.mkdirSync(dir);
    const identities = new Map(
        Object.values(paths).map((dir) => {
            const s = fs.lstatSync(dir, { bigint: true });
            return [dir, [s.dev, s.ino]];
        }),
    );
    const check = () => {
        checkAncestry(ancestry);
        const allowed = new Set([
            ...Object.values(paths).map((p) => path.basename(p)),
            ...(mode === ptyObservationMode
                ? []
                : [
                      'native-app',
                      'native-downloads',
                      'native-results',
                      'target-profile',
                      'native-will-quit.json',
                  ]),
        ]);
        for (const name of fs.readdirSync(root))
            assert(allowed.has(name), 'Unexpected application-owned route: ' + name);
        for (const dir of Object.values(paths)) {
            const s = fs.lstatSync(dir, { bigint: true });
            assert.deepEqual([s.dev, s.ino], identities.get(dir), 'Pilot subdirectory replaced.');
            assert(s.isDirectory() && !s.isSymbolicLink() && fs.realpathSync(dir) === dir);
        }
    };
    check();
    return { root, nonce, mode, ...paths, check } as Record<string, any>;
}
export function nativePilotLaunchRoutes(paths: Record<string, any>) {
    assert.notEqual(paths.mode, ptyObservationMode, 'PTY-only cannot admit native launch paths.');
    paths.check();
    return { artifactsDir: paths.artifactsDir, tracesDir: paths.tracesDir };
}
export function pilotEarlyAppPaths(paths: Record<string, any>) {
    assert.notEqual(paths.mode, ptyObservationMode, 'PTY-only cannot admit native app paths.');
    paths.check();
    return { temp: paths.temp, crashDumps: paths.crash, logs: paths.logs };
}
