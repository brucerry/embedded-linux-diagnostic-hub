import fs from 'node:fs/promises';
import path from 'node:path';
import { NativeCaptureStore } from '../../electron/capture-store';
import { physicalFS } from '../../electron/physical-fs';
import { CaptureWriter } from '../../shared/capture-writer';
async function main() {
    const [profile, mode, id] = process.argv.slice(2);
    if (!path.isAbsolute(profile) || !path.basename(profile).startsWith('hub-index-lifecycle-'))
        throw Error('An owned test profile is required.');
    const store = await NativeCaptureStore.open(profile, { profileOwned: true });
    const publish = (value: unknown) => {
        setInterval(() => {}, 1000);
        process.stdout.write(JSON.stringify(value) + '\n');
    };
    if (mode === 'write') {
        const writer = await CaptureWriter.begin(store, {
            transport: 'serial',
            receiveTimeSource: 'local-client',
            runId: 'crash-fixture',
            stepId: 'one',
            name: 'Interrupted synthetic capture',
            command: 'fixture',
            startedAt: '2026-10-15T00:00:00.000Z',
        });
        await writer.append(
            new Uint8Array([0, 255, 27, 91, 51, 49, 109, 65]),
            '2026-10-15T00:00:00.000Z',
            'serial',
        );
        await writer.flush();
        const file = path.join(profile, 'captures-v1', writer.id, 'raw.jsonl'),
            handle = await fs.open(file, 'a');
        await handle.write('{"uncommitted-tail":');
        await handle.sync();
        await handle.close();
        publish({
            stage: 'committed-prefix-and-uncommitted-tail',
            id: writer.id,
            raw: await fs.readFile(file, 'base64'),
        });
    } else if (mode === 'delete') {
        const unlink = physicalFS.promises.unlink.bind(physicalFS.promises);
        let removed = 0;
        physicalFS.promises.unlink = async (file) => {
            if (String(file).includes(path.sep + '.deleting-' + id + path.sep) && removed === 1) {
                publish({ stage: 'explicit-deletion-partial', id, removed });
                await new Promise<void>(() => {});
            }
            await unlink(file);
            if (String(file).includes(path.sep + '.deleting-' + id + path.sep)) removed++;
        };
        await store.delete(id);
        throw Error('Parent must terminate the owned process at the deletion gate.');
    } else throw Error('Unknown crash fixture mode.');
}
void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
