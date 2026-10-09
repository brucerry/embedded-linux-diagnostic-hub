import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Client } from 'ssh2';
import { SshSession, fingerprint } from '../backend/ssh/session';
import { adapterCommand, UART_SCRIPT } from '../backend/testing/adapters';
import { executeBounded, shellQuote } from '../backend/testing/executor';
import { sampleProfile, simulatedInventory } from '../shared/testing/simulation';
import { preparePlan } from '../shared/testing/profile';
import type { ConnectOptions } from '../shared/types';

async function main() {
    const connection = JSON.parse(
        await readFile(
            process.env.HUB_TEST_LINUX_CONNECTION || '.codex/linux-ssh/connection.json',
            'utf8',
        ),
    );
    const pinned = connection.expectedFingerprint || connection.fingerprint;
    if (!pinned) throw Error('A pinned qualification server fingerprint is required.');
    const options = { ...connection, auth: 'password' } as ConnectOptions,
        ssh = new SshSession();
    try {
        await ssh.connect(options, async (key) => key === pinned);
        const inventory = await ssh.discoverTests();
        assert.equal(inventory.mode, 'ssh');
        assert.ok(inventory.device.kernel);
        assert.equal((await ssh.readClock()).status, 'available');
        console.log(
            'Real Linux SSH read-only discovery and clock isolation verified:',
            inventory.resources.length,
            'resources;',
            inventory.nodes.length,
            'DT nodes;',
            JSON.stringify(inventory.capabilities),
        );
    } finally {
        ssh.disconnect();
    }
    const client = new Client();
    await new Promise<void>((resolve, reject) => {
        client.on('ready', resolve);
        client.on('error', reject);
        client.connect({
            host: options.host,
            port: options.port,
            username: options.username,
            password: options.password,
            hostVerifier: (key: Buffer) => fingerprint(key) === pinned,
        });
    });
    let fixture = '';
    try {
        const plan = await preparePlan(sampleProfile(), simulatedInventory()),
            led = adapterCommand(plan.cases[0]);
        const created = await executeBounded(
            client,
            'mktemp -d /tmp/diagnostic-hub-led-XXXXXX',
            undefined,
            5000,
            4096,
        );
        fixture = created.stdout.trim();
        assert.match(fixture, /^\/tmp\/diagnostic-hub-led-[A-Za-z0-9]+$/);
        // A regular file does not expose the kernel LED trigger's brackets after writes.
        // Emulate only that read formatting; run the production actuation/restoration script unchanged.
        const sedFixture = String.raw`#!/bin/sh
value=$(cat "$3")
case "$value" in *\[*) /bin/sed "$@";; *) printf '%s\n' "$value";; esac
`;
        const shim = await executeBounded(
            client,
            `mkdir ${shellQuote(fixture + '/bin')}; printf %s ${shellQuote(sedFixture)} > ${shellQuote(fixture + '/bin/sed')}; chmod 700 ${shellQuote(fixture + '/bin/sed')}`,
            undefined,
            5000,
            4096,
        );
        assert.equal(shim.exitCode, 0);
        const command =
            `export PATH=${shellQuote(fixture + '/bin')}:$PATH; ` +
            led.command.replace(plan.cases[0].resource!.path, fixture);
        const setup = `mkdir -p ${shellQuote(fixture)}; printf 7 > ${shellQuote(fixture + '/brightness')}; printf '[none]' > ${shellQuote(fixture + '/trigger')}`;
        const init = await executeBounded(client, setup, undefined, 5000, 4096);
        assert.equal(init.exitCode, 0);
        const result = await executeBounded(client, command, undefined, led.timeoutMs, 4096);
        assert.equal(result.exitCode, 0);
        assert.match(result.stdout, /HUB-LED-CLEANUP verified/);
        const check = await executeBounded(
            client,
            `cat ${shellQuote(fixture + '/brightness')}; printf '\\n'; cat ${shellQuote(fixture + '/trigger')}`,
            undefined,
            5000,
            4096,
        );
        assert.equal(check.stdout, '7\nnone');
        const failingSleep = await executeBounded(
            client,
            `printf %s ${shellQuote('#!/bin/sh\nexit 1\n')} > ${shellQuote(fixture + '/bin/sleep')}; chmod 700 ${shellQuote(fixture + '/bin/sleep')}; printf '[none]' > ${shellQuote(fixture + '/trigger')}`,
            undefined,
            5000,
            4096,
        );
        assert.equal(failingSleep.exitCode, 0);
        const failed = await executeBounded(client, command, undefined, led.timeoutMs, 4096);
        assert.equal(failed.exitCode, 1);
        assert.match(failed.stdout, /HUB-LED-CLEANUP verified/);
        const restored = await executeBounded(
            client,
            `cat ${shellQuote(fixture + '/brightness')}; printf '\\n'; cat ${shellQuote(fixture + '/trigger')}; rm -f ${shellQuote(fixture + '/bin/sleep')}`,
            undefined,
            5000,
            4096,
        );
        assert.equal(restored.stdout, '7\nnone');
        await executeBounded(
            client,
            `printf '[none]' > ${shellQuote(fixture + '/trigger')}`,
            undefined,
            5000,
            4096,
        );
        const abort = new AbortController(),
            job = executeBounded(client, command, abort.signal, led.timeoutMs, 4096);
        setTimeout(() => abort.abort(), 250);
        const cancelled = await job;
        assert.equal(cancelled.interrupted, true);
        assert.match(cancelled.stdout, /HUB-LED-CLEANUP verified/);
        console.log(
            'Real Linux LED script success/failure/cancel restoration verified against isolated temporary files; physical hardware unqualified.',
        );
    } finally {
        if (/^\/tmp\/diagnostic-hub-led-[A-Za-z0-9]+$/.test(fixture))
            await executeBounded(
                client,
                `rm -f ${shellQuote(fixture + '/brightness')} ${shellQuote(fixture + '/trigger')} ${shellQuote(fixture + '/bin/sed')} ${shellQuote(fixture + '/bin/sleep')}; rmdir ${shellQuote(fixture + '/bin')} ${shellQuote(fixture)}`,
                undefined,
                5000,
                4096,
            );
        client.end();
    }
    if (process.env.HUB_TEST_PYTHON) {
        const output = execFileSync(
            process.env.HUB_TEST_PYTHON,
            ['tests/fixtures/uart-helper.py'],
            { input: UART_SCRIPT, encoding: 'utf8' },
        );
        console.log(output.trim());
    }
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Linux qualification failed.');
    process.exitCode = 1;
});
