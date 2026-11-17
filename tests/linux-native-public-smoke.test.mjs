import assert from 'node:assert/strict';
import test from 'node:test';
import { launchOptions, verifyRenderer, runSmoke } from '../scripts/ci/linux-native-smoke.mjs';

const context = {
    source: 'a'.repeat(40),
    root: '/owned',
    project: '/source',
    appdir: '/owned/out/linux-unpacked',
    profile: '/owned/profile',
};
const environment = { DISPLAY: ':177', XAUTHORITY: '/owned/Xauthority' };
const observation = () => ({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    version: '0.6.0',
    argv: ['app'],
    rendererPid: 42,
    uid: 1000,
    noNewPrivs: '1',
    seccomp: '2',
    effectiveCaps: '00000000',
});
function fixture() {
    const calls = [],
        state = { now: 0, closeCalls: 0 };
    const window = {
        async waitForLoadState() {
            calls.push('DOM');
        },
        getByRole(role, options) {
            return {
                async waitFor() {
                    calls.push(role + ':' + options.name);
                },
                async click() {
                    assert.equal(options.name, 'Memory');
                    calls.push('Memory-click');
                },
            };
        },
        locator(selector) {
            assert.equal(selector, '.version-label');
            return {
                filter() {
                    return {
                        async waitFor() {
                            calls.push('version');
                        },
                    };
                },
            };
        },
    };
    const app = {
        async firstWindow() {
            calls.push('window');
            return window;
        },
        async close() {
            state.closeCalls++;
            calls.push('normal-close');
        },
    };
    const ports = {
        environment,
        uid: 1000,
        now: () => state.now,
        async verifyArchive() {
            calls.push('archive');
        },
        async launch(options) {
            assert.equal(options.chromiumSandbox, true);
            calls.push('launch');
            return app;
        },
        own(value) {
            assert.equal(value, app);
            calls.push('own');
        },
        async renderer() {
            calls.push('renderer');
            return observation();
        },
        async closed() {
            calls.push('closed');
        },
    };
    return { ports, app, window, calls, state };
}
test('launch explicitly enables sandbox and contains only the owned profile argument', () => {
    const value = launchOptions(context, environment);
    assert.equal(value.chromiumSandbox, true);
    assert.deepEqual(value.args, ['--user-data-dir=/owned/profile']);
    assert.equal(value.acceptDownloads, false);
});
test('display, authentication, profile or injected startup options refuse before launch', () => {
    for (const changed of [
        { DISPLAY: ':0' },
        { XAUTHORITY: '/other/auth' },
        { NODE_OPTIONS: 'benign-fixture' },
        { CHROME_DEVEL_SANDBOX: '/other/helper' },
        { WAYLAND_DISPLAY: 'fixture' },
    ])
        assert.throws(() => launchOptions(context, { ...environment, ...changed }));
    assert.throws(() => launchOptions({ ...context, profile: '/other/profile' }, environment));
});
test('product policy and renderer metadata each remain fail closed', () => {
    for (const changed of [
        { sandbox: false },
        { contextIsolation: false },
        { nodeIntegration: true },
        { argv: ['app', '--no-sandbox'] },
        { argv: ['app', '--disable-setuid-sandbox'] },
        { seccomp: '0' },
        { noNewPrivs: '0' },
        { effectiveCaps: '00000001' },
        { uid: 0 },
        { rendererPid: 0 },
        { version: '0.5.1' },
    ])
        assert.throws(() => verifyRenderer({ ...observation(), ...changed }, 1000));
});
test('memory success follows archive, ownership, window, one Memory action and normal close', async () => {
    const f = fixture(),
        result = await runSmoke(context, f.ports);
    assert.equal(result.status, 'pass');
    assert.equal(result.closure, true);
    assert.equal(result.qualified, false);
    assert.deepEqual(f.calls.slice(0, 5), ['archive', 'launch', 'own', 'window', 'DOM']);
    assert.equal(f.calls.filter((x) => x === 'Memory-click').length, 1);
    assert.deepEqual(f.calls.slice(-2), ['normal-close', 'closed']);
    assert.equal(f.state.closeCalls, 1);
});
test('an input mismatch never constructs or launches an application', async () => {
    const f = fixture();
    f.ports.verifyArchive = async () => {
        throw Error('fixture mismatch');
    };
    const result = await runSmoke(context, f.ports);
    assert.equal(result.reason, 'input');
    assert.equal(result.status, 'fail');
    assert.deepEqual(f.calls, []);
    assert.equal(f.state.closeCalls, 0);
});
test('launch failure remains unknown closure and does not try another launch', async () => {
    const f = fixture();
    let launches = 0;
    f.ports.launch = async () => {
        launches++;
        throw Error('fixture');
    };
    const result = await runSmoke(context, f.ports);
    assert.equal(launches, 1);
    assert.equal(result.status, 'fail');
    assert.equal(result.reason, 'launch');
    assert.equal(result.closure, false);
});
test('a renderer refusal prevents interaction and is not hidden by successful close', async () => {
    const f = fixture();
    f.ports.renderer = async () => ({ ...observation(), sandbox: false });
    const result = await runSmoke(context, f.ports);
    assert.equal(result.status, 'fail');
    assert.equal(result.reason, 'renderer');
    assert.equal(f.calls.includes('Memory-click'), false);
    assert.equal(f.state.closeCalls, 1);
});
test('a late launch result triggers no window, interaction, close or follow-on action', async () => {
    const f = fixture();
    f.ports.launch = async () => {
        f.state.now = 90001;
        return f.app;
    };
    const result = await runSmoke(context, f.ports);
    assert.equal(result.status, 'fail');
    assert.equal(result.reason, 'deadline');
    assert.deepEqual(f.calls, ['archive', 'own']);
    assert.equal(f.state.closeCalls, 0);
});
test('a close failure is attempted only once and never reported as closure', async () => {
    const f = fixture();
    f.app.close = async () => {
        f.state.closeCalls++;
        throw Error('fixture');
    };
    const result = await runSmoke(context, f.ports);
    assert.equal(result.status, 'fail');
    assert.equal(result.reason, 'close');
    assert.equal(result.closure, false);
    assert.equal(f.state.closeCalls, 1);
});
test('exit without verified pipe closure remains a failure', async () => {
    const f = fixture();
    f.ports.closed = async () => {
        throw Error('unknown pipe');
    };
    const result = await runSmoke(context, f.ports);
    assert.equal(result.status, 'fail');
    assert.equal(result.closure, false);
});
test('a close observed after deadline is recorded closed but cannot become success', async () => {
    const f = fixture();
    f.ports.closed = async () => {
        f.state.now = 90001;
    };
    const result = await runSmoke(context, f.ports);
    assert.equal(result.status, 'fail');
    assert.equal(result.reason, 'deadline');
    assert.equal(result.closure, true);
    assert.equal(f.state.closeCalls, 1);
});
