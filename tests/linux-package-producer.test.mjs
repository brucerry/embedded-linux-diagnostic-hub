import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stageLinuxProducer } from '../scripts/ci/linux-package-lane/stage-producer.mjs';

const pair = ['package.json', 'package-lock.json'];

async function freshCheckout(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'hub-producer-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', ['-C', root, ...args]);
    git('init', '-q');
    for (const name of pair) await writeFile(path.join(root, name), await readFile(name));
    git('add', ...pair);
    git('-c', 'user.name=Test Fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
        'commit', '-qm', 'Create disposable fixture');
    return root;
}

test('producer rejects absent pinned inputs before modifying either shared file', async (t) => {
    const root = await freshCheckout(t);
    await assert.rejects(stageLinuxProducer(root), /Linux producer inputs not verified/);
    for (const name of pair)
        assert.deepEqual(await readFile(path.join(root, name)), await readFile(name));
});

test('verified input fixture selects the whole Linux pair in the source root', async (t) => {
    const root = await freshCheckout(t);
    const result = await stageLinuxProducer(root, async (calledRoot) => {
        assert.equal(calledRoot, root);
        return Array.from({ length: 8 }, () => ({ status: 'verified' }));
    });
    assert.deepEqual(result, { staged: pair, verifiedArchives: 8, qualification: false });
    for (const name of pair)
        assert.deepEqual(await readFile(path.join(root, name)), await readFile(path.join('scripts/ci/linux-package-lane', name)));
});

test('actual workflow stages inputs only in the producer, before dependency installation', async () => {
    const workflow = await readFile('.github/workflows/linux-portable.yml', 'utf8');
    const [producer, consumer] = workflow.split(/^    gnome:$/m);
    assert.ok(consumer);
    assert.match(producer, /stage-producer\.mjs[^\n]*\n\s*- run: npm ci/);
    assert.doesNotMatch(consumer, /stage-producer\.mjs/);
    assert.match(consumer, /actions\/download-artifact/);
    assert.match(consumer, /- run: npm ci/);
});
