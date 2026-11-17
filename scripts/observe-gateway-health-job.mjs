import { fileURLToPath } from 'node:url';
import { createGatewayHealthJob } from './lib/gateway-health-job.mjs';
import { buildGatewayArchiveForHealthJob } from './lib/gateway-job-bootstrap.mjs';
import { createGatewaySmokePhysicalAdapter } from './lib/gateway-smoke-physical.mjs';
const heldKeepers = new Set();

/** Importing this entrypoint is inert. A referenced keeper preserves uncertain owned IO without
 * signalling, retrying or cleaning anything; the existing CI timeout is the outer hard bound.
 * A known-zero snapshot only permits process exit and never proves remote resource retirement.
 */
export async function observeGatewayHealthJob(runtime, bindings) {
    const job = createGatewayHealthJob(runtime, bindings);
    return observeOwnedGatewayJob(job, bindings);
}

// Both entrypoints share the same referenced keeper and known-zero exit rule.
export async function observeOwnedGatewayJob(job, bindings) {
    let cleared = false,
        clearIssued = false,
        clearFailure;
    const clear = () => {
        if (clearIssued) return;
        clearIssued = true;
        try {
            const value = bindings.clearInterval(keeper);
            if (value !== undefined) {
                heldKeepers.add(value);
                if (value && typeof value.then === 'function')
                    Promise.resolve(value).catch(() => {});
                throw new Error('Unsupported keeper close acknowledgment.');
            }
            cleared = true;
            heldKeepers.delete(keeper);
        } catch (cause) {
            clearFailure = new Error('Keeper closure uncertain.', { cause });
        }
    };
    const keeper = bindings.setInterval(() => {
        if (job.quiescent()) clear();
    }, 1000);
    heldKeepers.add(keeper);
    if (keeper && typeof keeper.then === 'function') {
        Promise.resolve(keeper).catch(() => {});
        throw new Error('Unsupported keeper registration.');
    }
    if (!keeper || typeof keeper.hasRef !== 'function' || keeper.hasRef() !== true)
        throw new Error('Referenced keeper was not established.');
    let result,
        failed = false,
        primary;
    try {
        result = await job.run();
    } catch (cause) {
        failed = true;
        primary = cause;
    } finally {
        if (job.quiescent()) clear();
    }
    if (failed) throw primary;
    if (clearFailure || !cleared) throw clearFailure ?? new Error('Keeper closure uncertain.');
    return result;
}

const entryFile = fileURLToPath(import.meta.url);
if (process.argv[1] === entryFile) {
    const names = [
        'GITHUB_ACTIONS',
        'GITHUB_REPOSITORY',
        'GITHUB_REF',
        'GITHUB_EVENT_NAME',
        'GITHUB_RUN_ATTEMPT',
        'GITHUB_JOB',
        'RUNNER_ENVIRONMENT',
        'RUNNER_OS',
        'RUNNER_ARCH',
        'GITHUB_SHA',
        'GITHUB_RUN_ID',
        'GITHUB_WORKFLOW_SHA',
        'GITHUB_WORKFLOW_REF',
        'GITHUB_WORKSPACE',
        'RUNNER_TEMP',
    ];
    const runtime = {
        entryFile,
        argv: [...process.argv],
        execArgv: [...process.execArgv],
        execPath: process.execPath,
        platform: process.platform,
        arch: process.arch,
        version: process.version,
        uid: process.getuid?.(),
        environment: Object.fromEntries(names.map((name) => [name, process.env[name]])),
    };
    try {
        await observeGatewayHealthJob(runtime, {
            build: buildGatewayArchiveForHealthJob,
            makeAdapter: createGatewaySmokePhysicalAdapter,
            setInterval,
            clearInterval,
        });
    } catch {
        process.exitCode = 1;
    }
}
