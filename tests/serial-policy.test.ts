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
