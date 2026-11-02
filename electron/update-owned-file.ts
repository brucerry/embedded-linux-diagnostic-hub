import { createHash } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { UpdateOwnership, updateErrors } from './update-ownership';

export async function writeUpdateFile(owner: UpdateOwnership, stage: string, file: string, data: string | Uint8Array) {
    const handle = await open(file, 'wx', 0o600);
    const custody = owner.hold(stage + ' handle', handle);
    const primary = { failed: false, error: undefined as unknown };
    const cleanup: unknown[] = [];
    try { await handle.writeFile(data); }
    catch (error) { primary.failed = true; primary.error = error; owner.diagnose(error); }
    try { await handle.close(); custody.acknowledge(); }
    catch (error) { custody.blocked(error); cleanup.push(error); }
    updateErrors(primary, cleanup);
}

/** Publication and source-name consumption are recorded before redundant cleanup. */
export async function publishUpdateFile(
    owner: UpdateOwnership, stage: string, temporary: string, destination: string,
    content: string, published: () => void,
) {
    const namespace = owner.hold(stage + ' temporary', temporary);
    const primary = { failed: false, error: undefined as unknown };
    const cleanup: unknown[] = [];
    try {
        await writeUpdateFile(owner, stage, temporary, content);
        const publication = owner.hold(stage + ' publication', destination);
        try {
            await rename(temporary, destination);
            owner.publication(stage, 'published'); publication.acknowledge();
        } catch (error) {
            owner.publication(stage, 'uncertain'); publication.blocked(error); throw error;
        }
        namespace.acknowledge(); // The successful rename consumed this owned name.
        published();
    } catch (error) { primary.failed = true; primary.error = error; owner.diagnose(error); }
    try { await rm(temporary, { force: true }); namespace.acknowledge(); }
    catch (error) { namespace.blocked(error); cleanup.push(error); }
    updateErrors(primary, cleanup);
}

export async function removeUpdateFile(owner: UpdateOwnership, stage: string, file: string) {
    const custody = owner.hold(stage, file);
    try { await rm(file, { force: true }); owner.publication(stage, 'removed'); custody.acknowledge(); }
    catch (error) { custody.blocked(error); throw error; }
}

/** Explicit descriptor closure, independently of hash/read success. */
export async function hashUpdateFile(owner: UpdateOwnership, file: string, limit: number): Promise<string> {
    const handle = await open(file, 'r');
    const custody = owner.hold('verification handle', handle);
    const primary = { failed: false, error: undefined as unknown }, cleanup: unknown[] = [];
    let result: string | undefined;
    try {
        const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024); let size = 0;
        while (true) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.length)
                throw Error('Invalid update verification byte count.');
            if (!bytesRead) break;
            size += bytesRead;
            if (size > limit) throw Error('The downloaded update has changed.');
            hash.update(buffer.subarray(0, bytesRead));
        }
        result = hash.digest('hex');
    } catch (error) { primary.failed = true; primary.error = error; owner.diagnose(error); }
    try { await handle.close(); custody.acknowledge(); }
    catch (error) { custody.blocked(error); cleanup.push(error); }
    updateErrors(primary, cleanup); return result!;
}
