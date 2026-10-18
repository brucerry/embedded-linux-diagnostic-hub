import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
export function ptyBridgeArguments(bash: string, script: string, home: string) {
    assert.ok(path.win32.isAbsolute(bash) && !/["\r\n]/.test(bash));
    return [
        '-NoProfile',
        '-File',
        script,
        '-BashExecutable',
        bash,
        '-CommandLine',
        '"' + bash + '" --noprofile -i',
        '-WorkingDirectory',
        home,
        '-DeadlineMs',
        '15000',
    ];
}
export async function installedPtyIdentity(file: string) {
    const canonical = await fs.realpath(file),
        stat = await fs.lstat(canonical);
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    const handle = await fs.open(canonical, 'r');
    let machine: number;
    try {
        const header = Buffer.alloc(1048576),
            { bytesRead } = await handle.read(header, 0, header.length, 0);
        assert.equal(header.toString('ascii', 0, 2), 'MZ');
        const offset = header.readUInt32LE(60);
        assert.ok(offset >= 64 && offset + 26 <= bytesRead);
        assert.equal(header.readUInt32LE(offset), 0x4550);
        machine = header.readUInt16LE(offset + 4);
        assert.equal(machine, 0x8664, 'Installed PTY tool is not the required x64 PE binary.');
    } finally {
        await handle.close();
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(canonical)) hash.update(chunk);
    const after = await fs.lstat(canonical);
    assert.equal(after.ino, stat.ino);
    assert.equal(after.dev, stat.dev);
    assert.equal(after.size, stat.size);
    return {
        path: canonical,
        sha256: hash.digest('hex'),
        bytes: stat.size,
        peMachine: machine,
        architecture: 'x64' as const,
    };
}
