// Inert Node IPC fixture only: model provider transport; never launches WinPS or product code.
import { queryLeaf } from '../../scripts/lib/security-query-diagnostic-runtime.mjs';
import { modelReply, identity } from './security-query-diagnostic-model.mjs';
// macOS libSystem may inject this key into a clean env; remove only in this fixture.
if (process.platform === 'darwin') delete process.env.__CF_USER_TEXT_ENCODING;
const timeoutFixture = process.argv[4] === '--timeout-fixture';
await queryLeaf(process.argv.slice(2, 4), {
    hold(state, record, { onRetained }) {
        const h = { outcome: Promise.resolve() };
        onRetained(h);
        try {
            record('ownership-held.json', state);
        } catch {}
        return h;
    },
    platform: 'win32',
    arch: 'x64',
    identity,
    queryOptions: {
        identity,
        spawn(_exe, _args, options) {
            const plans = JSON.parse(options.env.HUB_NATIVE_PILOT_SECURITY_PATHS);
            if (timeoutFixture)
                return {
                    pid: 12345,
                    status: null,
                    signal: 'SIGTERM',
                    error: Object.assign(Error('controlled timeout'), { code: 'ETIMEDOUT' }),
                    stdout: '',
                    stderr: '',
                };
            return {
                pid: 12345,
                status: 0,
                signal: null,
                stdout: JSON.stringify(modelReply({ plans, expected: 'green' })),
                stderr: '',
            };
        },
    },
});
