import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { stopProfileProcesses } from './fixtures/processes';

test(
    'relaunch cleanup handles rewritten argv and resistant descendants without stopping other profiles',
    {
        skip: process.platform !== 'linux',
        timeout: 15000,
    },
    async () => {
        const profile = `/tmp/hub-cleanup-${randomUUID()}/profile`;
        const script = `
        const { spawn } = require('node:child_process');
        process.title = 'fake-electron --user-data-dir=' + process.argv[1] + ' --test';
        process.on('SIGTERM', () => {});
        const child = spawn(process.execPath, ['-e',
            "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"
        ], { stdio: ['ignore', 'pipe', 'ignore'] });
        child.stdout.once('data', () => console.log(child.pid));
        setInterval(() => {}, 1000);
    `;
        const owned = spawn(process.execPath, ['-e', script, profile], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const unrelated = spawn(process.execPath, [
            '-e',
            "process.title = 'fake-electron --user-data-dir=' + process.argv[1]; setInterval(() => {}, 1000)",
            `${profile}-other`,
        ]);
        const closed = once(owned, 'close');
        let childPid: number | undefined;
        try {
            const [data] = await once(owned.stdout!, 'data');
            childPid = Number(String(data).trim());
            assert.ok(childPid > 1);
            const title = await readFile(`/proc/${owned.pid}/cmdline`, 'utf8');
            assert.ok(title.includes(`fake-electron --user-data-dir=${profile} --test`));
            await stopProfileProcesses(profile);
            const [code, signal] = await closed;
            assert.equal(code, null);
            assert.equal(signal, 'SIGKILL');
            const childState = await readFile(`/proc/${childPid}/stat`, 'utf8').catch(() => '');
            assert.ok(
                !childState || childState.slice(childState.lastIndexOf(')') + 2).startsWith('Z '),
            );
            assert.equal(unrelated.exitCode, null);
            assert.equal(unrelated.signalCode, null);
            process.kill(unrelated.pid!, 0);
        } finally {
            owned.kill('SIGKILL');
            unrelated.kill('SIGKILL');
            if (childPid) {
                try {
                    process.kill(childPid, 'SIGKILL');
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
                }
            }
        }
    },
);
