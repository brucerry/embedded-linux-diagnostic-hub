import { physicalFS } from './physical-fs';
import { assertPlainAncestors } from './setup-paths';
import { unlinkOwnedFile, replaceOwnedMetadata } from './setup-paths';
const { lstat, realpath, open } = physicalFS.promises;
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const same = (a: string, b: string) =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
async function plainParents(directory: string) {
    let current = path.resolve(directory);
    while (true) {
        const stat = await lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw Error('Setup channel directory aliases are refused.');
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    if (!same(await realpath(directory), path.resolve(directory)))
        throw Error('Setup channel directory identity differs.');
    return lstat(directory);
}
async function regularBytes(file: string, limit: number) {
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit)
        throw Error('Setup channel requires a bounded regular file.');
    const handle = await open(file, 'r');
    try {
        const active = await handle.stat();
        if (
            active.ino !== before.ino ||
            active.dev !== before.dev ||
            !active.isFile() ||
            active.nlink !== 1
        )
            throw Error('Setup channel file identity changed.');
        const bytes = Buffer.alloc(limit + 1);
        const read = await handle.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead > limit) throw Error('Setup channel file exceeds its bound.');
        const after = await lstat(file);
        if (after.ino !== before.ino || after.dev !== before.dev || after.isSymbolicLink())
            throw Error('Setup channel file was replaced.');
        return bytes.subarray(0, read.bytesRead);
    } finally {
        await handle.close();
    }
}
export const decodeSetupINI = (bytes: Buffer) =>
    bytes[0] === 0xff && bytes[1] === 0xfe
        ? bytes.toString('utf16le').replace(/^\uFEFF/, '')
        : bytes.toString('utf8');
export async function setupChannel(request: string, response: string) {
    if (
        !path.isAbsolute(request) ||
        !path.isAbsolute(response) ||
        !same(path.dirname(request), path.dirname(response)) ||
        path.basename(request) !== 'setup-request.ini' ||
        path.basename(response) !== 'setup-response.ini'
    )
        throw Error('Use the verified setup front door.');
    const directory = path.dirname(request),
        identity = await plainParents(directory),
        requestBytes = await regularBytes(request, 16384);
    const assertParent = async () => {
        const current = await plainParents(directory);
        if (current.dev !== identity.dev || current.ino !== identity.ino)
            throw Error('Setup channel directory changed.');
    };
    const write = async (values: Record<string, unknown>) => {
        await assertParent();
        try {
            const prior = decodeSetupINI(await regularBytes(response, 65536));
            if (!prior.startsWith('[setup]\r\nproduct=DiagnosticHub\r\n'))
                throw Error('Setup response is not owned.');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const content =
            '[setup]\r\nproduct=DiagnosticHub\r\n' +
            Object.entries(values)
                .map(([key, value]) => {
                    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key))
                        throw Error('Invalid setup response key.');
                    return (
                        key +
                        '=' +
                        String(value ?? '')
                            .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
                            .slice(0, 4096)
                    );
                })
                .join('\r\n') +
            '\r\n';
        const temporary = path.join(directory, '.setup-response-' + randomUUID() + '.tmp');
        await assertPlainAncestors(temporary);
        const handle = await open(temporary, 'wx', 0o600);
        try {
            await handle.writeFile(
                Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]),
            );
            await handle.sync();
        } finally {
            await handle.close();
        }
        try {
            await assertParent();
            try {
                const target = await lstat(response);
                if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1)
                    throw Error('Setup response aliases are refused.');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            await replaceOwnedMetadata(temporary, response);
            await assertParent();
        } catch (error) {
            await unlinkOwnedFile(temporary).catch(() => {});
            throw error;
        }
    };
    return { request: decodeSetupINI(requestBytes), write };
}
