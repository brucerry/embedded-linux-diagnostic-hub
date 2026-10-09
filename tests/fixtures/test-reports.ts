import { sampleProfile, simulatedInventory } from '../../shared/testing/simulation';
import { TestController, blankEvidence } from '../../shared/testing/runner';
import { createTestReport } from '../../shared/testing/report';
import type { TestReport } from '../../shared/testing/types';

export async function documentFixtures(): Promise<TestReport[]> {
    const inventory = simulatedInventory(),
        profile = sampleProfile();
    profile.name = 'Engineering bench - 裝置 α <markup>';
    profile.boardRevision = 'Revision A / ' + 'engineering-review-'.repeat(6);
    const base = profile.tests;
    profile.tests = [
        base[0],
        { ...base[2], id: 'identity-pass' },
        { ...base[2], id: 'identity-blocked' },
        base[1],
        { ...base[2], id: 'identity-skipped' },
    ];
    profile.sequences[0].tests = profile.tests.map((t) => t.id);
    profile.sequences[0].stopOnFailure = true;
    const controller = new TestController(
        async () => structuredClone(inventory),
        async (c) => ({
            ...blankEvidence(
                c.test.adapter === 'uart.loopback' ? 'mismatch' : 'ok',
                'Software fixture observation.',
            ),
            exitCode: 0,
            durationMs: 21,
            measured:
                c.test.adapter === 'i2c.identity'
                    ? 68
                    : c.test.adapter === 'uart.loopback'
                      ? '00'
                      : 'pattern-executed',
            cleanup: c.test.adapter === 'i2c.identity' ? 'not-needed' : 'verified',
            cleanupDetail: 'Software fixture restoration verified.',
            stdout:
                c.test.adapter === 'led.pattern'
                    ? 'Unicode 裝置 α and <script>alert(1)</script>\n' +
                      Array.from(
                          { length: 100 },
                          (_, i) => `Evidence ${i + 1}: ` + 'abcdefghijklmnop'.repeat(10),
                      ).join('\n')
                    : 'Bounded test output.',
        }),
    );
    await controller.discoverInventory();
    await controller.start({
        profile,
        inventoryId: inventory.id,
        testIds: profile.sequences[0].tests,
        sequence: 'bench',
        readiness: {
            reviewed: true,
            fixtures: Object.fromEntries(
                profile.tests.map((t) => [
                    t.id,
                    {
                        ready: t.id !== 'identity-blocked',
                        identity: 'Fixture α / qualified software path only',
                    },
                ]),
            ),
        },
    });
    while (controller.busy) await new Promise((r) => setTimeout(r, 1));
    const pending = createTestReport(controller.read()!);
    const mixed = createTestReport(
        controller.confirm({ runId: pending.run.id, testId: base[0].id, value: 'unobserved' }),
    );
    return [pending, mixed];
}
