/** Explicit packaged permanent-folder entry. The portable and review-only entries are unchanged. */
import path from 'node:path';
import { linuxReviewSourceRoot } from '../electron/linux-setup-review';
import {
    linuxPermanentArguments,
    runLinuxPermanentSetup,
    linuxPermanentSetupDiagnostics,
} from '../electron/linux-permanent-setup';
import { linuxTerminalPrompt } from '../electron/linux-setup-prompts';

export async function linuxSetupInstallEntry(args: string[]) {
    process.stdout.on('error', () => {});
    process.stderr.on('error', () => {});
    const choices = linuxPermanentArguments(args);
    if (
        process.platform !== 'linux' ||
        process.arch !== 'x64' ||
        !process.versions.electron ||
        process.env.ELECTRON_RUN_AS_NODE !== '1' ||
        !process.getuid ||
        !process.geteuid
    )
        throw Error('LINUX_PERMANENT_RUNTIME');
    const sourceRoot = linuxReviewSourceRoot(process.execPath);
    if (process.argv[1] !== path.posix.join(sourceRoot, 'app/resources/linux-setup-install.cjs'))
        throw Error('LINUX_PERMANENT_ENTRY');
    const home = process.env.HOME ?? '',
        terminal = linuxTerminalPrompt();
    const desktop = Object.fromEntries(
        ['DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY']
            .filter((key) => Boolean(process.env[key]))
            .map((key) => [key, process.env[key]!]),
    );
    const result = await runLinuxPermanentSetup(
        {
            platform: 'linux',
            arch: 'x64',
            uid: process.getuid(),
            euid: process.geteuid(),
            home,
            appData: process.env.XDG_CONFIG_HOME || path.posix.join(home, '.config'),
            sourceRoot,
            version: choices.version,
        },
        choices,
        process.env.XDG_DATA_HOME || path.posix.join(home, '.local/share'),
        {
            terminal,
            gui: { review: async () => ({ status: 'unavailable' }), hasPending: () => false },
            now: () => performance.now(),
        },
        desktop,
    );
    const custody = linuxPermanentSetupDiagnostics(result.owner);
    if (custody.phase === 'retained-unknown' || terminal.hasPending()) {
        // Keep custody before any best-effort diagnostic can throw. Logging never authorizes exit.
        setInterval(() => {}, 60000);
        try {
            process.stdout.write(
                'Linux setup stopped with retained unresolved ownership. Preserve this process and its artifacts.\n',
            );
        } catch {
            // Preserve the existing operation failure and unresolved owners.
        }
        return new Promise<never>(() => {});
    }
    if (custody.phase === 'refused') {
        process.stdout.write('Linux setup refused this operation. No completion is claimed.\n');
        return 78;
    }
    process.stdout.write(
        result.status === 'cancelled'
            ? 'Linux setup cancelled before changes.\n'
            : result.status === 'current-payload-removed'
              ? 'Linux current initial no-menu payload removed. Settings, reports and original transaction records are retained.\n'
            : 'Linux setup operation completed; previous transaction artifacts remain retained.\n',
    );
    return result.status === 'cancelled' ? 1 : 0;
}
if (typeof require !== 'undefined' && require.main === module) {
    void linuxSetupInstallEntry(process.argv.slice(2))
        .then((code) => {
            process.exitCode = code;
        })
        .catch(() => {
            process.stderr.on('error', () => {});
            process.stderr.write('Linux permanent setup entry unavailable.\n');
            process.exitCode = 78;
        });
}
