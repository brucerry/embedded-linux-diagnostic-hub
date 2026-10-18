import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWinpsSecurityContract } from './lib/pilot-winps-contract.mjs';
export async function winpsContractMain(args = process.argv.slice(2), environment = process.env) {
    assert.equal(environment.HUB_WINDOWS_PILOT_WINPS_CONTRACT, '1');
    assert.notEqual(environment.HUB_WINDOWS_NATIVE_PILOT, '1');
    assert.notEqual(environment.HUB_WINDOWS_PREFLIGHT_ONLY, '1');
    const options = Object.fromEntries(
        args.map((a) => {
            assert(/^--(?:out|expected-source)=.+$/.test(a));
            return a.slice(2).split(/=(.*)/s).slice(0, 2);
        }),
    );
    assert(
        args.length === 2 &&
            Object.keys(options).length === 2 &&
            options.out &&
            options['expected-source'],
    );
    const controller = new AbortController(),
        cancel = () => controller.abort(Error('WinPS contract entry cancelled'));
    for (const event of ['SIGINT', 'SIGTERM', 'disconnect']) process.on(event, cancel);
    try {
        return await runWinpsSecurityContract({
            sourceRoot: path.resolve(import.meta.dirname, '..'),
            outputRoot: options.out,
            expectedSourceSHA256: options['expected-source'],
            environment,
            signal: controller.signal,
        });
    } finally {
        for (const event of ['SIGINT', 'SIGTERM', 'disconnect']) process.off(event, cancel);
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    winpsContractMain()
        .then((r) => {
            console.log(JSON.stringify(r));
            if (!r.passed) process.exitCode = 1;
        })
        .catch((e) => {
            console.error(String(e));
            process.exitCode = 1;
        });
