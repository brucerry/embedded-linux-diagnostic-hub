import assert from 'node:assert/strict';
import test from 'node:test';
import {
    SETUP_ACTIONS,
    setupActionPresentation,
    renderSetupPresentationNSIS,
} from '../shared/setup-presentation';

test('removal and recovery presentation states their effect and cannot fall back to Install', () => {
    const removal = setupActionPresentation('finishremove');
    assert.equal(removal.label, 'Continue application removal');
    assert.equal(removal.button, 'Remove');
    assert.match(removal.effect, /removing.*owned shortcuts.*uninstall entry/);
    assert.match(removal.effect, /settings and reports are retained/);
    const confirmation = setupActionPresentation('finalize');
    assert.equal(confirmation.button, 'Confirm');
    assert.match(confirmation.effect, /remove the retained previous application copy/);
    const recovery = setupActionPresentation('rollback');
    assert.equal(recovery.button, 'Recover');
    assert.match(recovery.effect, /remove failed or staged application files/);
    assert.throws(() => setupActionPresentation('unexpected'), /Unsupported/);
});
test('one catalog generates distinct friendly labels and exact worker tokens with no implicit action', () => {
    assert.equal(new Set(SETUP_ACTIONS.map((action) => action.label)).size, SETUP_ACTIONS.length);
    for (const action of SETUP_ACTIONS) assert.notEqual(action.label, action.token);
    const include = renderSetupPresentationNSIS();
    assert.match(include, /StrCpy \$HubOperation ""/);
    assert.match(include, /canfinishremove[\s\S]*Continue application removal/);
    assert.match(
        include,
        /\$HubActionLabel == "Continue application removal"[\s\S]*StrCpy \$HubOperation "finishremove"/,
    );
    assert.match(
        include,
        /\$HubOperation == "finishremove"[\s\S]*StrCpy \$HubActionButton "Remove"/,
    );
});
