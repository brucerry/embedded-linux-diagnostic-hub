/** Bundled source entry for the existing Electron runtime's Node mode; never requires end-user Node. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { linuxReviewSourceRoot, reviewLinuxAppDir } from '../electron/linux-setup-review';
import {
    linuxReviewArguments,
    runLinuxGuidedReview,
    finishLinuxReview,
} from '../electron/linux-setup-ui';
import { linuxTerminalPrompt } from '../electron/linux-setup-prompts';
export async function linuxSetupReviewEntry(args: string[]) {
    const choices = linuxReviewArguments(args);
    if (
        process.platform !== 'linux' ||
        process.arch !== 'x64' ||
        !process.versions.electron ||
        process.env.ELECTRON_RUN_AS_NODE !== '1' ||
        !process.getuid ||
        !process.geteuid
    )
        throw Error('LINUX_REVIEW_RUNTIME_UNAVAILABLE');
    const sourceRoot = linuxReviewSourceRoot(process.execPath);
    if (
        process.argv[1] !==
        path.posix.join(sourceRoot, 'app', 'resources', 'linux-setup-review.cjs')
    )
        throw Error('LINUX_REVIEW_ENTRY_BINDING');
    // Refuse mutation/launch before opening a prompt or dispatching any helper action.
    if (choices.operation !== 'review') throw Error('LINUX_REVIEW_HELPER_REFUSED');
    const home = process.env.HOME ?? '',
        host = {
            platform: process.platform,
            arch: process.arch,
            uid: process.getuid(),
            euid: process.geteuid(),
            home,
            appData: process.env.XDG_CONFIG_HOME || path.posix.join(home, '.config'),
            sourceRoot,
            version: choices.version,
            requirePackagedReviewCapability: true as const,
        };
    const terminal = linuxTerminalPrompt();
    const result = await runLinuxGuidedReview(
        host,
        { ...choices, terminal: true },
        process.env.XDG_DATA_HOME || path.posix.join(home, '.local/share'),
        {
            inspect: (root) => reviewLinuxAppDir(host, root),
            terminal,
            gui: { review: async () => ({ status: 'unavailable' }), hasPending: () => false },
            now: () => performance.now(),
            newId: randomUUID,
        },
    );
    process.stdout.on('error', () => {});
    return finishLinuxReview(result, {
        write: (text) => {
            process.stdout.write(text);
        },
        hasPending: () => terminal.hasPending(),
        hold: () => {
            setInterval(() => {}, 60000);
            return new Promise<never>(() => {});
        },
    });
}
if (typeof require !== 'undefined' && require.main === module) {
    void linuxSetupReviewEntry(process.argv.slice(2))
        .then((code) => {
            process.exitCode = code;
        })
        .catch(() => {
            process.stderr.on('error', () => {});
            process.stderr.write(
                'Linux setup review unavailable. No installation was performed.\n',
            );
            process.exitCode = 78;
        });
}
