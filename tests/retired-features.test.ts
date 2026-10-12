import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { gatewayFixture } from './fixtures/gateway';
import { probes } from '../shared/diagnostics/probes';
import { GatewayClient } from '../src/services/GatewayClient';
import { SshSession } from '../backend/ssh/session';
import { withNativeLinuxWindow } from '../electron/linux-window-identity';

test('retired Tests endpoints reject authenticated requests without remote execution or session loss', async () => {
    const fixture = await gatewayFixture();
    try {
        const connection = await fixture.request('/api/sessions', 'POST', fixture.options);
        assert.equal(connection.status, 201);
        const { sessionId } = await connection.json();
        const executions = fixture.probeExecutions();
        const authenticated = fixture.authentications();
        for (const route of [
            'inventory',
            'prepare',
            'start',
            'run',
            'cancel',
            'confirm',
            'clear',
        ]) {
            const response = await fixture.request(
                `/api/sessions/${sessionId}/tests/${route}`,
                route === 'run' ? 'GET' : 'POST',
                route === 'run' ? undefined : {},
            );
            assert.equal(response.status, 404);
            assert.equal((await response.json()).error, 'Unknown gateway route.');
        }
        assert.equal(fixture.probeExecutions(), executions);
        assert.equal(fixture.authentications(), authenticated);
        assert.equal(
            (await fixture.request(`/api/sessions/${sessionId}/clock`, 'POST')).status,
            200,
        );
        const snapshot = await fixture.request(`/api/sessions/${sessionId}/snapshot`, 'POST');
        assert.equal(snapshot.status, 200);
        assert.equal((await snapshot.json()).results.length, probes.length);
        assert.equal(fixture.authentications(), authenticated);
    } finally {
        await fixture.close();
    }
});

test('client and SSH public APIs have no retired Tests operations', () => {
    for (const prototype of [GatewayClient.prototype, SshSession.prototype]) {
        assert.deepEqual(
            Object.getOwnPropertyNames(prototype).filter((name) => /test/i.test(name)),
            [],
        );
    }
});

test('ordinary delivery keeps checksum verification and never manages a desktop extension', async () => {
    const launcher = await readFile('public/download-run.sh', 'utf8');
    assert.match(launcher, /sha256sum --check --status/);
    assert.match(launcher, /Invalid release checksum document/);
    assert.match(launcher, /--proto '=https'/);
    assert.doesNotMatch(launcher, /Genie|genie|gnome-extensions|gsettings|gdbus|python3|apt-get/);
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    const main = await readFile('electron/main.ts', 'utf8');
    assert.equal(pkg.desktopName, 'diagnostic-hub.desktop');
    assert.equal(pkg.build.appId, 'dev.diagnostichub.desktop');
    assert.equal(pkg.build.linux.executableName, 'diagnostic-hub');
    assert.equal(pkg.build.linux.desktop.entry.StartupWMClass, 'diagnostic-hub-native');
    assert.match(
        main,
        /withNativeLinuxWindow\(\(name\) => app.setDesktopName\(name\), createWindow\)/,
    );
    // Both released legacy formats require this exact old class AND desktop ID.
    const legacyMatches = (wmClass: string, desktopId: string) =>
        wmClass.toLowerCase() === 'diagnostic-hub' && desktopId === 'diagnostic-hub.desktop';
    assert.equal(legacyMatches('diagnostic-hub-native', pkg.desktopName), false);
    assert.doesNotMatch(main, /setPath\('userData'|hub:window-motion|hub:tests-/);
});

test('workspace view and navigation cannot restore redundant Reports/Evidence or Tests pages', async () => {
    const view = await readFile('src/app/view.ts', 'utf8');
    const app = await readFile('src/app/App.tsx', 'utf8');
    assert.doesNotMatch(view, /'tests'|'reports'|'evidence'/);
    assert.doesNotMatch(
        app,
        /label="(?:Tests|Reports? & [Ee]vidence)"|setView\('(?:tests|reports|evidence)'\)/,
    );
    assert.match(app, /useState<View>\('overview'\)/);
});

test('native Linux window identity restores the stable desktop identity on success and failure', () => {
    let identity = 'diagnostic-hub.desktop';
    const setIdentity = (name: string) => {
        identity = name;
    };
    const window = withNativeLinuxWindow(setIdentity, () => {
        assert.equal(identity, 'diagnostic-hub-native.desktop');
        return { wmClass: identity.replace(/\.desktop$/, '') };
    });
    assert.equal(window.wmClass, 'diagnostic-hub-native');
    assert.equal(identity, 'diagnostic-hub.desktop');
    assert.throws(
        () =>
            withNativeLinuxWindow(setIdentity, () => {
                throw Error('window creation failed');
            }),
        /window creation failed/,
    );
    assert.equal(identity, 'diagnostic-hub.desktop');
});
