import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspectArtifactCarrier, carrierCRC32 } from '../scripts/lib/artifact-carrier-zip.mjs';
import { WEB_ARCHIVE_LIMITS } from '../scripts/lib/web-archive-limits.mjs';

const names = [
    'Diagnostic-Hub-Web-0.6.0.zip',
    'Diagnostic-Hub-Web-0.6.0.zip.sha256',
    'web-build.json',
];
const expected = new Map([
    [names[0], WEB_ARCHIVE_LIMITS.archive],
    [names[1], 256],
    [names[2], 16 * 1024 ** 2],
]);
function carrier(files) {
    const local = [],
        central = [];
    let offset = 0;
    for (const [name, bytes] of files) {
        const filename = Buffer.from(name),
            crc = carrierCRC32(bytes);
        const head = Buffer.alloc(30),
            entry = Buffer.alloc(46);
        head.writeUInt32LE(0x04034b50);
        head.writeUInt16LE(20, 4);
        head.writeUInt32LE(crc, 14);
        head.writeUInt32LE(bytes.length, 18);
        head.writeUInt32LE(bytes.length, 22);
        head.writeUInt16LE(filename.length, 26);
        entry.writeUInt32LE(0x02014b50);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt32LE(crc, 16);
        entry.writeUInt32LE(bytes.length, 20);
        entry.writeUInt32LE(bytes.length, 24);
        entry.writeUInt16LE(filename.length, 28);
        entry.writeUInt32LE(offset, 42);
        local.push(head, filename, bytes);
        central.push(entry, filename);
        offset += head.length + filename.length + bytes.length;
    }
    const directory = Buffer.concat(central),
        end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(files.size, 8);
    end.writeUInt16LE(files.size, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, directory, end]);
}

test('real web producer CLI retains source-owned native capability and guarded main entry', async () => {
    const entry = await readFile(
        new URL('../scripts/produce-web-archive.mjs', import.meta.url),
        'utf8',
    );
    assert.ok(entry.includes('const native = requireOwnedWebCapabilities(capability)'));
    assert.ok(entry.includes('() => main(process.argv.slice(2))'));
});

test('future readback carrier keeps its exact three-file profile and unsupported service gate', async () => {
    const readback = await readFile(
        new URL('../scripts/lib/archive-service-readback.mjs', import.meta.url),
        'utf8',
    );
    assert.match(readback, /\[name, WEB_ARCHIVE_LIMITS\.archive\]/);
    assert.match(readback, /\[name \+ '\.sha256', 256\]/);
    assert.match(readback, /\[recordName, 16 \* 1024 \*\* 2\]/);
    assert.match(
        readback,
        /Authenticated service transport, artifact-to-job attribution and terminal reader evidence are not implemented/,
    );
});

test('actual carrier parser accepts exact synthetic upload selection', () => {
    const files = new Map(
        names.map((name) => [name, Buffer.from('synthetic carrier member ' + name)]),
    );
    assert.deepEqual(inspectArtifactCarrier(carrier(files), expected), files);
});

for (const mode of [
    'missing-record',
    'legacy-launcher',
    'nested-member',
    'extra-site-file',
    'wrong-version',
]) {
    test('actual carrier parser refuses incompatible upload: ' + mode, () => {
        const files = new Map(names.map((name) => [name, Buffer.from('synthetic')]));
        if (mode === 'missing-record') files.delete('web-build.json');
        if (mode === 'legacy-launcher') {
            files.delete('web-build.json');
            files.set('download-run.sh', Buffer.from('synthetic'));
        }
        if (mode === 'nested-member') {
            files.delete('web-build.json');
            files.set('validation/web-source/web-build.json', Buffer.from('synthetic'));
        }
        if (mode === 'extra-site-file') files.set('site/index.html', Buffer.from('synthetic'));
        if (mode === 'wrong-version') {
            files.delete(names[0]);
            files.set('Diagnostic-Hub-Web-0.6.1.zip', Buffer.from('synthetic'));
        }
        assert.throws(() => inspectArtifactCarrier(carrier(files), expected));
    });
}
