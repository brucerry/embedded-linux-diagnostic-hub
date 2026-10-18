import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { argumentsOf } from './memory-resource-core';
import { requireNegativeDetection, type Exit } from './memory-resource-verdict';
import { sha256 } from './memory-resource-identity';
import { resourceJob, observeResourceOwner } from '../../scripts/lib/resource-owner.mjs';
async function main() {
    const args = argumentsOf(process.argv.slice(2));
    if (args.has('policy'))
        assert.ok(
            args.get('policy')?.trim(),
            'Provide a nonempty reviewed policy path; diagnostic fallback is forbidden.',
        );
    const argument = process.argv.find((value) => value.startsWith('--out='));
    assert.ok(argument, 'Provide --out=<private evidence directory>.');
    const base = path.resolve(argument.slice(6));
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, 'negative-controls-'));
    const policySHA256 = args.has('policy')
        ? (args.get('policy-sha256') ?? process.env.HUB_MEMORY_POLICY_SHA256 ?? '')
        : null;
    if (args.has('policy')) {
        assert.match(
            policySHA256!,
            /^[a-f0-9]{64}$/,
            'Provide the independently reviewed policy SHA256.',
        );
        assert.equal(
            sha256(await fs.readFile(args.get('policy')!)),
            policySHA256,
            'Reviewed policy bytes changed.',
        );
    }
    const checks = {
        js: /retained-heapUsed/,
        buffer: /retained-arrayBuffers/,
        listener: /unsettled owners.*listener/,
        timer: /Unreleased timer owners/,
        pin: /unsettled owners.*pin/,
    };
    const results = [];
    const selected = args.get('controls')?.split(',') ?? Object.keys(checks);
    assert.ok(
        selected.length &&
            selected.every((control) => Object.hasOwn(checks, control)) &&
            new Set(selected).size === selected.length,
        'Unknown or duplicate negative controls.',
    );
    for (const control of selected) {
        const expected = checks[control as keyof typeof checks];
        const output = path.join(root, control);
        await fs.mkdir(output);
        const job = resourceJob('fast');
        const outcome = await (async () => {
            const child = spawn(
                process.execPath,
                [
                    ...process.execArgv,
                    fileURLToPath(new URL('./memory-resource-regression.ts', import.meta.url)),
                    '--profile=fast',
                    ...(args.has('policy')
                        ? ['--policy=' + args.get('policy'), '--policy-sha256=' + policySHA256]
                        : ['--diagnostic=1']),
                    `--negative=${control}`,
                    `--out=${output}`,
                    ...(args.has('no-sampler') ? ['--no-sampler=1'] : []),
                ],
                {
                    windowsHide: true,
                    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
                    env: { ...process.env, HUB_MEMORY_JOB: JSON.stringify(job) },
                },
            );
            return observeResourceOwner(child, job).outcome;
        })();
        const [folder] = await fs.readdir(output);
        const log = await fs.readFile(path.join(output, folder, 'child.log'), 'utf8');
        const receipt = JSON.parse(
            await fs.readFile(path.join(output, folder, 'receipt.json'), 'utf8'),
        );
        requireNegativeDetection(control, outcome, receipt, log, expected, policySHA256);
        results.push({ control, ...outcome, expectedFailureObserved: true, output });
    }
    await fs.writeFile(
        path.join(root, 'expected-failures.json'),
        JSON.stringify(results, null, 2),
        { flag: 'wx' },
    );
}
void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
