// Runs only in the explicitly isolated Shell.Eval qualification bus.
(async () => {
    const { default: GLib } = await import('gi://GLib');
    const { default: Gio } = await import('gi://Gio');
    const uuid = 'diagnostic-hub-genie@diagnostichub.desktop';
    // The legacy importer exists in modern GJS too, but removed misc modules throw.
    let legacyConfig;
    try {
        legacyConfig = imports.misc.config;
    } catch {
        /* Modern ESM Shell. */
    }
    const legacy = legacyConfig?.PACKAGE_VERSION?.startsWith('42.');
    const Main = legacy ? imports.ui.main : await import('resource:///org/gnome/shell/ui/main.js');
    let extension = Main.extensionManager.lookup(uuid).stateObj;
    const actor = global.get_window_actors().find((a) => extension._matches(a));
    const result = { ok: false, minimized: false, focused: false, resizeRequests: 0 };
    const stress = '__STRESS_ENABLED__' === '1';
    const candidateRequired = '__PRIVATE_LAYER__' === '1';
    const candidate = global.hubQualificationPrivateLayer;
    const wait = (ms) =>
        new Promise((resolve) =>
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            }),
        );
    try {
        if (!actor) throw Error('Target window missing');
        if (candidateRequired && (!candidate || candidate.actor !== actor))
            throw Error('Candidate layer adapter missing during continuity');
        if (candidateRequired) result.privateLayerBefore = candidate.snapshot();
        // The larger native fixture disables the extension at its end. Re-enable in this
        // disposable bus so connected/simulated runs cross the actual production effect.
        if (!extension._enabled) Main.extensionManager._callExtensionEnable(uuid);
        extension = Main.extensionManager.lookup(uuid).stateObj;
        actor.meta_window.minimize();
        await wait(90);
        if (!actor.get_effect('diagnostic-hub-genie'))
            throw Error('Production effect was not active during continuity motion');
        if (candidateRequired && !actor.get_effect('hub-native-private-layer'))
            throw Error('Candidate layer missing during native motion');
        if (stress) {
            const b = actor.meta_window.get_frame_rect();
            actor.meta_window.move_resize_frame(true, b.x, b.y, 1080, 730);
            result.resizeRequests++;
        }
        await wait(490);
        result.minimized = actor.meta_window.minimized;
        actor.meta_window.activate(global.get_current_time());
        await wait(90);
        if (candidateRequired && !actor.get_effect('hub-native-private-layer'))
            throw Error('Candidate layer missing during native motion');
        if (stress) {
            const b = actor.meta_window.get_frame_rect();
            actor.meta_window.move_resize_frame(true, b.x, b.y, 1100, 760);
            result.resizeRequests++;
        }
        await wait(490);
        result.focused = global.display.focus_window === actor.meta_window;
        if (candidateRequired) {
            result.privateLayerAfter = candidate.snapshot();
            if (
                result.privateLayerAfter.added !== result.privateLayerBefore.added + 2 ||
                result.privateLayerAfter.removed !== result.privateLayerBefore.removed + 2 ||
                result.privateLayerAfter.remaining !== 0
            )
                throw Error('Candidate continuity lifetime mismatch');
        }
        result.ok =
            result.minimized &&
            result.focused &&
            !actor.meta_window.minimized &&
            extension._active.size === 0;
        if (!result.ok) throw Error('Native continuity transition did not recover');
    } catch (error) {
        result.error = String(error);
    }
    Gio.File.new_for_path('__REPORT_PATH__').replace_contents(
        JSON.stringify(result),
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null,
    );
})();
