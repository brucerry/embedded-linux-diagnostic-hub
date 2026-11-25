import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkVendorArchives } from './check-inputs.mjs';

const lane = path.dirname(fileURLToPath(import.meta.url));
const names = ['package.json', 'package-lock.json'];

export async function stageLinuxProducer(directory, verify = checkVendorArchives) {
    assert.equal(process.platform, 'linux');
    assert.equal(process.arch, 'x64');
    const root = await realpath(directory);
    const git = (args) => execFileSync('git', ['-C', root, ...args]);
    assert.equal(git(['rev-parse', '--show-toplevel']).toString().trim(), root);
    for (const name of names) {
        const target = path.join(root, name);
        assert.ok((await lstat(target)).isFile(), 'Expected a regular checkout file: ' + name);
        assert.deepEqual(await readFile(target), git(['show', 'HEAD:' + name]), 'Dirty checkout: ' + name);
    }
    const entries = await verify(root);
    assert.equal(entries.length, 8, 'Eight archive pins required');
    const blocked = entries.filter(({ status }) => status !== 'verified');
    if (blocked.length)
        throw new Error('Linux producer inputs not verified: ' + blocked.map(({ name, status }) => name + ' (' + status + ')').join(', '));

    const [manifest, lock] = await Promise.all(names.map((name) => readFile(path.join(lane, name))));
    const pkg = JSON.parse(manifest);
    const graph = JSON.parse(lock).packages[''];
    for (const field of ['dependencies', 'devDependencies'])
        assert.deepEqual(pkg[field], graph[field], 'Linux package pair disagrees: ' + field);

    // The workflow stops on any failure; no install step can start after a partial copy.
    const scratch = await mkdtemp(path.join(root, '.linux-plan-'));
    try {
        for (const [name, data] of [[names[0], manifest], [names[1], lock]])
            await writeFile(path.join(scratch, name), data, { flag: 'wx', mode: 0o600 });
        for (const name of names) await rename(path.join(scratch, name), path.join(root, name));
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
    for (const [name, data] of [[names[0], manifest], [names[1], lock]])
        assert.deepEqual(await readFile(path.join(root, name)), data);
    return { staged: names, verifiedArchives: entries.length, qualification: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const workspace = process.argv[2];
    assert.equal(process.argv.length, 3);
    assert.ok(path.isAbsolute(workspace));
    console.log(JSON.stringify(await stageLinuxProducer(workspace)));
}
