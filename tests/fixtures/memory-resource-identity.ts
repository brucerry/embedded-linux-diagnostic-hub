import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createReadStream } from 'node:fs';
export const sha256 = (bytes: string | Uint8Array) =>
    createHash('sha256').update(bytes).digest('hex');
export async function nodeRuntimeIdentity() {
    const executablePath = await fs.realpath(process.execPath),
        hash = createHash('sha256');
    for await (const chunk of createReadStream(executablePath)) hash.update(chunk);
    return {
        executablePath,
        executableSHA256: hash.digest('hex'),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        versions: process.versions,
        execArgv: [...process.execArgv],
        nodeOptions: process.env.NODE_OPTIONS ?? null,
    };
}
/** Hash sorted paths and content; exclude generated/dependency data, refuse aliases. */
export async function sourceFingerprint(directory: string) {
    const hash = createHash('sha256');
    async function visit(relative: string) {
        const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
        for (const item of entries.sort((a, b) =>
            a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        )) {
            if (
                [
                    '.git',
                    'node_modules',
                    'validation',
                    'dist',
                    'dist-web',
                    'dist-site',
                    'dist-gateway',
                    'dist-electron',
                    'release',
                    'test-results',
                ].includes(item.name)
            )
                continue;
            const name = path.join(relative, item.name);
            if (item.isSymbolicLink()) throw Error(`Source identity refuses symlink: ${name}`);
            if (item.isDirectory()) await visit(name);
            else {
                hash.update(name.replaceAll('\\', '/'));
                hash.update('\0');
                hash.update(sha256(await fs.readFile(path.join(directory, name))));
                hash.update('\n');
            }
        }
    }
    await visit('');
    return hash.digest('hex');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    void sourceFingerprint(path.resolve(process.argv[2] ?? '.'))
        .then(console.log)
        .catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
