import test from 'node:test';
import { exerciseRealPtyAssertions } from './fixtures/console-real-pty-assertions';
test(
    'existing real Bash/winpty OS PTY through pinned loopback SSH preserves normal aliases, cwd and explicit Enter',
    { timeout: 25000 },
    async (t) => {
        await exerciseRealPtyAssertions({
            skip: (r) => t.skip(r),
            diagnostic: (r) => t.diagnostic(r),
        });
    },
);
