import assert from 'node:assert/strict';
import test from 'node:test';
import { allowsSerial, SerialSelection } from '../electron/serial-policy';
import type { SerialChooser } from '../shared/serial';
test('serial permission is exact document, main frame, contents, type and origin scoped', () => {
    const contents = {};
    for (const documentUrl of ['app://bundle/index.html', 'http://127.0.0.1:5173/']) {
        const origin = documentUrl.startsWith('app:') ? 'app://bundle' : 'http://127.0.0.1:5173';
        const details = { isMainFrame: true, securityOrigin: origin, requestingUrl: documentUrl };
        const check = (c = contents, permission = 'serial', o = origin, d = details) =>
            allowsSerial(documentUrl, contents, c, permission, o, d);
        assert.equal(check(), true);
        assert.equal(check({}), false);
        assert.equal(check(contents, 'usb'), false);
        assert.equal(check(contents, 'serial', 'null'), false);
        assert.equal(check(contents, 'serial', origin, { ...details, isMainFrame: false }), false);
        assert.equal(
            check(contents, 'serial', origin, {
                ...details,
                requestingUrl: documentUrl + '?untrusted',
            }),
            false,
        );
        assert.equal(
            check(contents, 'serial', origin, { ...details, securityOrigin: 'https://evil.test' }),
            false,
        );
    }
});
test('synthetic chooser requires offered IDs and replies once, including cancellation/hotplug', () => {
    let view: SerialChooser | null = null;
    const replies: string[] = [];
    const chooser = new SerialSelection((value) => {
        view = value;
    });
    chooser.start([{ id: 'a', name: 'COM7' }], (id) => replies.push(id));
    const id = view!.id;
    assert.equal(replies.length, 0);
    assert.throws(() => chooser.select('old', 'a'));
    assert.throws(() => chooser.select(id, 'b'));
    chooser.update([{ id: 'b', name: 'ttyUSB0' }]);
    assert.throws(() => chooser.select(id, 'a'));
    chooser.select(id, 'b');
    chooser.cancel();
    assert.deepEqual(Array.from(replies), ['b']);
    assert.equal(view, null);
    chooser.start([], (port) => replies.push(port));
    chooser.start([], (port) => replies.push(port));
    chooser.cancel();
    assert.deepEqual(Array.from(replies), ['b', '', '']);
});

test('Electron root-slash origins preserve trusted Serial access without accepting URL paths', () => {
    const owner = {};
    const documentUrl = 'app://bundle/index.html';
    for (const origin of ['app://bundle', 'app://bundle/']) {
        for (const securityOrigin of ['app://bundle', 'app://bundle/']) {
            assert.equal(
                allowsSerial(documentUrl, owner, owner, 'serial', origin, {
                    isMainFrame: true,
                    requestingUrl: documentUrl,
                    securityOrigin,
                }),
                true,
            );
        }
    }
    for (const untrusted of [
        'app://bundle/other',
        'app://bundle/?query',
        'app://bundle/#fragment',
        'app://evil/',
        'null',
    ]) {
        assert.equal(
            allowsSerial(documentUrl, owner, owner, 'serial', untrusted, {
                isMainFrame: true,
                requestingUrl: documentUrl,
                securityOrigin: 'app://bundle/',
            }),
            false,
        );
    }
});

test('chooser preserves every offered COM11/built-in/USB/virtual identity without optional USB metadata', () => {
    let view: SerialChooser | null = null;
    const replies: string[] = [];
    const chooser = new SerialSelection((value) => {
        view = value;
    });
    const ports = Array.from({ length: 129 }, (_, index) => ({
        id: 'os-' + index,
        name: 'COM' + (index + 1),
    }));
    ports.push(
        { id: 'built-in-linux', name: '/dev/ttyS0' },
        { id: 'usb-linux', name: '/dev/ttyUSB0' },
        { id: 'virtual', name: 'COM4096' },
        { id: 'mac-driver', name: '/dev/cu.driver' },
    );
    chooser.start(ports, (id) => replies.push(id));
    try {
        assert.equal(view!.ports.length, ports.length);
        assert.equal(view!.ports.find((p) => p.id === 'os-10')!.name, 'COM11');
        assert.equal(view!.ports.find((p) => p.id === 'virtual')!.name, 'COM4096');
        assert.throws(() => chooser.select(view!.id, 'not-offered'));
        chooser.select(view!.id, 'os-128');
        assert.deepEqual(replies, ['os-128']);
    } finally {
        chooser.cancel();
    }
});

test('both Serial origin fields reject extra components, credentials and malformed spellings', () => {
    const owner = {},
        documentUrl = 'app://bundle/index.html';
    const invalid = [
        'app://evil/',
        'app://bundle/path',
        'app://bundle/?q',
        'app://bundle/#hash',
        'app://user@bundle/',
        'app://bundle//',
        'app://bundle/../',
        'app:bundle',
        'app://bundle:443/',
        'APP://bundle/',
        ' app://bundle/',
        'null',
        '',
    ];
    for (const value of invalid) {
        assert.equal(
            allowsSerial(documentUrl, owner, owner, 'serial', value, {
                isMainFrame: true,
                requestingUrl: documentUrl,
                securityOrigin: 'app://bundle/',
            }),
            false,
        );
        assert.equal(
            allowsSerial(documentUrl, owner, owner, 'serial', 'app://bundle/', {
                isMainFrame: true,
                requestingUrl: documentUrl,
                securityOrigin: value,
            }),
            false,
        );
    }
});
