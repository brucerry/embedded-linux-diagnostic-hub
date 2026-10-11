// Test-only held poses of the real native effect in an owned isolated session.
(async () => {
    const { default: GLib } = await import('gi://GLib');
    const { default: Gio } = await import('gi://Gio');
    const { default: Clutter } = await import('gi://Clutter');
    const { default: GObject } = await import('gi://GObject');
    const { default: Meta } = await import('gi://Meta');
    const Main = await import('resource:///org/gnome/shell/ui/main.js');
    const uuid = 'diagnostic-hub-genie@diagnostichub.desktop';
    let ext = Main.extensionManager.lookup(uuid).stateObj;
    const actor = global.get_window_actors().find((a) => ext._matches(a));
    const { deform } = await import(`file://${ext.path}/geometry.js`);
    const dockSettings = new Gio.Settings({ schema_id: 'org.gnome.shell.extensions.dash-to-dock' });
    const originalDock = dockSettings.get_enum('dock-position');
    const add = actor.add_effect_with_name,
        remove = actor.remove_effect;
    const timelineStart = Clutter.Timeline.prototype.start;
    const layers = new Map();
    const report = {
        ok: false,
        frames: [],
        checks: [],
        scope: 'real native effect held-pose geometry; not 500ms cadence qualification',
        privateLayer: { enabled: '__PRIVATE_LAYER__' === '1', added: 0, removed: 0, remaining: 0 },
        dockActors: [],
    };
    const wait = (ms) =>
        new Promise((resolve) =>
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            }),
        );
    const Wrapper = GObject.registerClass(
        class HubDockVisualLayer extends Clutter.OffscreenEffect {},
    );
    let volumeAdapter;
    if (report.privateLayer.enabled && '__VOLUME_CONTROL__' === '1') {
        volumeAdapter = global.hubQualificationVolumeAdapter(actor, report.privateLayer);
    } else if (report.privateLayer.enabled) {
        actor.add_effect_with_name = function (name, effect) {
            if (name === 'diagnostic-hub-genie') {
                const layer = new Wrapper();
                add.call(this, 'hub-native-private-layer', layer);
                layers.set(effect, layer);
                report.privateLayer.added++;
            }
            return add.call(this, name, effect);
        };
        actor.remove_effect = function (effect) {
            const value = remove.call(this, effect),
                layer = layers.get(effect);
            if (layer) {
                remove.call(this, layer);
                layers.delete(effect);
                layer.run_dispose();
                report.privateLayer.removed++;
            }
            return value;
        };
    }
    Clutter.Timeline.prototype.start = function () {
        if (this.get_actor() === actor) this.set_duration(6000);
        return timelineStart.call(this);
    };
    const hidden = new Map();
    const hide = (a) => {
        if (a && !hidden.has(a)) {
            hidden.set(a, a.opacity);
            a.opacity = 0;
        }
    };
    const unhide = () => {
        for (const [a, opacity] of hidden) a.opacity = opacity;
        hidden.clear();
    };
    const snapshot = async (effect, direction, progress) => {
        effect.heldProgress = progress;
        effect.invalidate();
        actor.queue_redraw();
        let paints = 0;
        const signal = global.stage.connect('after-paint', () => paints++);
        const start = GLib.get_monotonic_time();
        try {
            while (paints < 2 && GLib.get_monotonic_time() - start < 400000) await wait(15);
        } finally {
            global.stage.disconnect(signal);
        }
        if (paints < 2) throw Error('held pose did not paint twice');
        await wait(70); // Bounded devkit/PipeWire delivery after stable pose paints.
        const record = {
            direction,
            progress,
            edge: effect.edge,
            source: effect.source,
            target: effect.target,
            actor: [actor.x, actor.y, actor.width, actor.height],
            canvas: effect.canvas,
            effectStack: actor.get_effects().map((item) => ({
                name: item.get_name(),
                type: item.constructor.name,
                beforePaint: item.beforePaint,
                texture:
                    item instanceof Clutter.OffscreenEffect && item.get_texture()
                        ? [item.get_texture().get_width(), item.get_texture().get_height()]
                        : null,
            })),
            clipToAllocation: actor.get_clip_to_allocation(),
            hasClip: actor.has_clip,
            parents: (() => {
                const values = [];
                for (let parent = actor.get_parent(); parent; parent = parent.get_parent())
                    values.push({
                        type: parent.constructor.name,
                        clip: parent.has_clip,
                        clipToAllocation: parent.get_clip_to_allocation(),
                        bounds: [parent.x, parent.y, parent.width, parent.height],
                    });
                return values;
            })(),
            effectTextureSize: [
                effect.get_texture().get_width(),
                effect.get_texture().get_height(),
            ],
            paints,
            heldMs: (GLib.get_monotonic_time() - start) / 1000,
        };
        record.expectedVertices = [0, 0.5, 1].flatMap((tx) =>
            [0, 0.5, 1].map((ty) => {
                const p = deform(effect.source, effect.target, effect.edge, progress, tx, ty);
                return { x: p.x + actor.x, y: p.y + actor.y, tx, ty };
            }),
        );
        const layer = actor.get_effect('hub-native-private-layer');
        if (report.privateLayer.enabled && !layer?.get_texture())
            throw Error('private output layer has no painted texture; visual control is invalid');
        const index = report.frames.length;
        report.frames.push(record);
        const captureStart = GLib.get_monotonic_time();
        const [, , , status] = GLib.spawn_sync(
            null,
            ['xwd', '-root', '-silent', '-out', '__REPORT_PATH__' + '.' + index + '.xwd'],
            null,
            GLib.SpawnFlags.SEARCH_PATH,
            null,
        );
        if (status !== 0) throw Error('outer capture failed');
        record.captureMs = (GLib.get_monotonic_time() - captureStart) / 1000;
        if (actor.get_effect('diagnostic-hub-genie') !== effect)
            throw Error('native effect expired before capture finished');
    };
    try {
        if (!ext._enabled) Main.extensionManager._callExtensionEnable(uuid);
        ext = Main.extensionManager.lookup(uuid).stateObj;
        Main.overview.hide();
        // Clear notifications only on this disposable session bus, preserving host preferences.
        report.dismissedNotifications = 0;
        for (const source of Main.messageTray.getSources())
            for (const n of [...source.notifications]) {
                n.destroy();
                report.dismissedNotifications++;
            }
        await wait(350);
        actor.meta_window.unmaximize(Meta.MaximizeFlags.BOTH);
        actor.meta_window.move_resize_frame(true, 350, 200, 700, 450);
        actor.meta_window.activate(global.get_current_time());
        await wait(700);
        for (const [position, edge] of [
            [0, 'top'],
            [1, 'right'],
            [2, 'bottom'],
            [3, 'left'],
        ].filter(([, edge]) => '__TOP_ONLY__' !== '1' || edge === 'top')) {
            dockSettings.set_enum('dock-position', position);
            await wait(500);
            for (const direction of ['out', 'in']) {
                unhide();
                if (direction === 'out') actor.meta_window.minimize();
                else actor.meta_window.activate(global.get_current_time());
                await wait(35);
                const effect = actor.get_effect('diagnostic-hub-genie');
                if (!effect || effect.edge !== edge)
                    throw Error('native edge/effect absent ' + edge + ' ' + direction);
                let progress = direction === 'out' ? 0 : 1;
                Object.defineProperty(effect, 'progress', {
                    get: () => progress,
                    set: () => {},
                    configurable: true,
                });
                Object.defineProperty(effect, 'heldProgress', {
                    set: (v) => {
                        progress = v;
                    },
                    configurable: true,
                });
                let dock = Main.overview.dash;
                const chain = [];
                while (
                    dock &&
                    dock.get_parent() !== Main.uiGroup &&
                    dock.get_parent() !== global.stage
                ) {
                    chain.push(dock.constructor.name);
                    dock = dock.get_parent();
                }
                report.dockActors.push({ edge, direction, chain, root: dock?.constructor.name });
                hide(dock);
                hide(Main.messageTray);
                for (const control of global.get_window_actors())
                    if (control !== actor) hide(control);
                for (const p of direction === 'out'
                    ? [0, 0.25, 0.55, 0.85, 0.99, 1]
                    : [1, 0.99, 0.85, 0.55, 0.25, 0])
                    await snapshot(effect, direction, p);
                ext._active.get(actor)?.finish();
                unhide();
                await wait(250);
                if (layers.size || volumeAdapter?.ownedLayers.size)
                    throw Error('held visual layer leaked');
            }
        }
        report.checks.push(
            '__TOP_ONLY__' === '1'
                ? 'actual-native-top-held-poses'
                : 'actual-native-four-edge-held-poses',
            'dock-hidden-after-native-anchor-only',
            'two-paints-and-bounded-delivery-before-capture',
            'layer-cleanup',
        );
        report.ok = true;
    } catch (error) {
        report.error = String(error) + '\n' + String(error.stack ?? '');
    } finally {
        ext._finishAll();
        unhide();
        Clutter.Timeline.prototype.start = timelineStart;
        if (volumeAdapter) volumeAdapter.restore();
        actor.add_effect_with_name = add;
        actor.remove_effect = remove;
        report.privateLayer.remaining = volumeAdapter
            ? volumeAdapter.ownedLayers.size
            : layers.size;
        dockSettings.set_enum('dock-position', originalDock);
        actor.meta_window.activate(global.get_current_time());
        Gio.File.new_for_path('__REPORT_PATH__').replace_contents(
            JSON.stringify(report),
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null,
        );
    }
})();
