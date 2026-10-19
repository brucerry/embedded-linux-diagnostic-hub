import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const text = fs.readFileSync(
    new URL('../.github/workflows/windows-portable.yml', import.meta.url),
    'utf8',
);
const jobs = [
    'build',
    'windows-preflight-only',
    'windows-native-pilot',
    'winps-provider-contract',
    'windows-pty-observation',
    'windows-observation-pair',
    'windows-observation-approval',
];
function selected(job: string, inputs: Record<string, unknown>, event = 'workflow_dispatch') {
    const body = text.split('\n    ' + job + ':\n')[1]!.split(/\n    [a-z][a-z-]*:/)[0]!;
    let expression = body
        .slice(body.indexOf('        if:') + 11)
        .split(/\n        (?:runs-on|timeout-minutes|permissions):/)[0]!
        .trim()
        .replace(/^>-\s*/, '')
        .replace(/^\$\{\{\s*|\s*\}\}$/g, '');
    expression = expression
        .replaceAll('github.event_name', JSON.stringify(event))
        .replace(/inputs\.([a-z_]+)/g, (_, key) => JSON.stringify(inputs[key] ?? ''));
    assert(/^[\s()!&|=\w'".{}:-]+$/.test(expression), expression);
    return Function('return (' + expression + ')')();
}
test('manual pair and approval selectors exclude every standing build and finite mode across all128 combinations', () => {
    const keys = [
        'windows_preflight_only',
        'windows_native_pilot',
        'windows_pilot_winps_contract',
        'windows_pty_observation_only',
        'windows_observation_pair',
        'observation_request_json',
        'observation_approve_json',
    ];
    for (let mask = 0; mask < 128; mask++) {
        const inputs = Object.fromEntries(
            keys.map((key, i) => [
                key,
                !!(mask & (1 << i))
                    ? key.endsWith('_json')
                        ? '{}'
                        : true
                    : key.endsWith('_json')
                      ? ''
                      : false,
            ]),
        );
        const active = jobs.filter((job) => selected(job, inputs));
        if (
            inputs.windows_observation_pair ||
            inputs.observation_request_json ||
            inputs.observation_approve_json
        ) {
            assert(
                active.every((job) =>
                    ['windows-observation-pair', 'windows-observation-approval'].includes(job),
                ),
                JSON.stringify({ inputs, active }),
            );
            assert(active.length <= 1);
        }
    }
    assert(
        selected('windows-observation-pair', {
            windows_observation_pair: true,
            observation_request_json: '{}',
        }),
    );
    assert(selected('windows-observation-approval', { observation_approve_json: '{}' }));
    for (const event of ['push', 'pull_request', 'workflow_call'])
        for (const job of jobs.slice(5))
            assert(
                !selected(
                    job,
                    {
                        windows_observation_pair: true,
                        observation_request_json: '{}',
                        observation_approve_json: '{}',
                    },
                    event,
                ),
            );
});
test('approval can run while the owner waits; owned bounds and evidence retention are explicit', () => {
    assert(text.includes("format('-observation-approval-{0}', github.run_id)"));
    assert.match(text, /inputs\.windows_observation_pair\s*&&\s*'-observation-pair'/);
    assert(text.includes('timeout-minutes: 130'));
    assert(text.includes('retention-days: 14'));
    assert(
        text.indexOf('Refuse disabled source before dependency or PTY execution') <
            text.indexOf('Fresh reviewed PTY gate on this allocation'),
    );
    const approval = text.split('    windows-observation-approval:\n')[1]!;
    assert(!approval.includes('npm ci'));
    assert(!approval.includes('windows-observation-pair.mts'));
});
