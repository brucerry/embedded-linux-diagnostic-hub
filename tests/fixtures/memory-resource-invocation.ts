/** Metadata-only commands. Never import a driver, launch a product, or read process memory. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { argumentsOf } from './memory-resource-core';
import { sourceFingerprint, nodeRuntimeIdentity, sha256 } from './memory-resource-identity';
import { sshQualificationProfile } from './memory-resource-ssh-profile';
import { fastIdentity } from './memory-fast-identity';
import {
    calibrationProfile,
    stageReviewedPolicy,
    writeQualificationMetadata,
} from './memory-resource-policy';

async function main() {
    const args = argumentsOf(process.argv.slice(2)),
        operation = args.get('operation');
    assert.ok(operation === 'identity' || operation === 'policy');
    const kind = args.get('policy-kind') ?? 'fast';
    assert.ok(kind === 'fast' || kind === 'soak');
    const target =
        operation === 'identity'
            ? (args.get('identity-for') ?? 'fast')
            : kind === 'soak'
              ? 'soak'
              : (args.get('profile') ?? 'fast');
    assert.ok(['fast', 'scale', 'soak'].includes(target));
    const root = path.resolve(import.meta.dirname, '../..');
    const selected =
        target === 'soak'
            ? { profile: 'soak', payloadBytes: 33 * 1024 ** 2 }
            : calibrationProfile(target);
    const config = {
        ...selected,
        sourceSHA256: await sourceFingerprint(root),
        runtimeIdentity: await nodeRuntimeIdentity(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        observerMode: args.has('no-sampler') ? 'disabled' : 'sampled',
        gcMode: target === 'soak' ? (args.get('gc') ?? 'normal') : 'forced-diagnostic',
    };
    if (target !== 'soak')
        Object.assign(config, {
            contract: await fastIdentity(
                root,
                config.observerMode,
                await sshQualificationProfile(),
            ),
        });
    if (target === 'soak') assert.ok(['normal', 'forced'].includes(config.gcMode));
    let result: unknown;
    if (operation === 'identity')
        result = {
            schema: 1,
            kind: 'memory-harness-runtime-inspection',
            config,
            packageVersion: JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
                .version,
            sshRuntime: await sshQualificationProfile(),
            scope: 'Actual harness Node executable/flags/source only. No product role identity, workload, memory sample or qualification.',
        };
    else {
        const json = process.env.HUB_MEMORY_POLICY_JSON,
            expectedSHA256 = process.env.HUB_MEMORY_POLICY_SHA256;
        assert.ok(
            json && expectedSHA256,
            'Provide externally reviewed HUB_MEMORY_POLICY_JSON and HUB_MEMORY_POLICY_SHA256.',
        );
        let assessment, driverSHA256;
        if (kind === 'soak') {
            const file = args.get('assessment-context'),
                expected = process.env.HUB_MEMORY_ASSESSMENT_SHA256;
            assert.ok(
                file && expected,
                'Product policy requires its reviewed actual assessment-context file and SHA256.',
            );
            const bytes = await fs.readFile(file);
            assert.ok(bytes.length <= 256 * 1024);
            assert.equal(sha256(bytes), expected, 'Reviewed assessment context bytes changed.');
            assessment = JSON.parse(bytes.toString());
            const driver = args.get('driver');
            assert.ok(driver, 'Provide the actual product adapter module for hashing.');
            driverSHA256 = sha256(await fs.readFile(driver));
        }
        result = await stageReviewedPolicy({
            root,
            json,
            expectedSHA256,
            kind,
            config,
            assessment,
            driverSHA256,
            lane: args.get('lane'),
            gcMode: args.get('gc') ?? 'normal',
            viewer: args.has('viewer'),
        });
    }
    if (args.has('out'))
        await writeQualificationMetadata(root, args.get('out')!, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
}
void main().catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
    const args = argumentsOf(process.argv.slice(2));
    if (args.has('out')) {
        try {
            await writeQualificationMetadata(
                path.resolve(import.meta.dirname, '../..'),
                args.get('out')!,
                JSON.stringify(
                    {
                        status: 'failed-metadata-check',
                        operation: args.get('operation'),
                        firstFailure: String(error).slice(0, 4096),
                        workloadStarted: false,
                    },
                    null,
                    2,
                ),
            );
        } catch (reportError) {
            console.error(
                'Failure metadata could not be preserved: ' + String(reportError).slice(0, 1024),
            );
        }
    }
});
