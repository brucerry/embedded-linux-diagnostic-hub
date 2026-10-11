// Runs only through Shell.Eval in an explicitly isolated qualification session.
// These native actions and observations are deliberately absent from the companion's API.
(async () => {
    const { default: GLib } = await import('gi://GLib');
    const { default: Gio } = await import('gi://Gio');
    const { default: Meta } = await import('gi://Meta');
    const { default: Clutter } = await import('gi://Clutter');
    const { default: Shell } = await import('gi://Shell');
    // The legacy importer exists in modern GJS too, but removed misc modules throw.
    let legacyConfig;
    try {
        legacyConfig = imports.misc.config;
    } catch {
        /* Modern ESM Shell. */
    }
    const legacy = legacyConfig?.PACKAGE_VERSION?.startsWith('42.');
    const Main = legacy ? imports.ui.main : await import('resource:///org/gnome/shell/ui/main.js');
    const Config = legacy
        ? legacyConfig
        : await import('resource:///org/gnome/shell/misc/config.js');
    const uuid = 'diagnostic-hub-genie@diagnostichub.desktop';
    const destination = '__REPORT_PATH__';
    const exportTextures = '__TEXTURE_EXPORT__' === '1';
    const textureExports = [];
    const result = { shell: Config.PACKAGE_VERSION, cycles: 0, native: {}, frames: [], checks: [] };
    const stressEnabled = '__STRESS_ENABLED__' === '1';
    const resultStress = {
        enabled: stressEnabled,
        cycles: 0,
        resizeRequests: 0,
        observedSizeChanges: 0,
    };
    result.stress = resultStress;
    const recoveryTimes = [],
        loopGaps = [],
        paintGaps = [];
    let stressActive = false,
        loopPrevious = 0,
        paintPrevious = 0,
        paintSignal = 0;
    const summarize = (values) => {
        const sorted = [...values].sort((a, b) => a - b);
        return {
            samples: sorted.length,
            p50: sorted[Math.floor(sorted.length * 0.5)] ?? null,
            p95: sorted[Math.floor(sorted.length * 0.95)] ?? null,
            max: sorted.at(-1) ?? null,
        };
    };
    let cancelled = false;
    global.hubQualificationCancel = () => {
        cancelled = true;
    };
    const wait = (ms) =>
        new Promise((resolve) =>
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                if (cancelled) resolve('cancelled');
                else resolve();
                return GLib.SOURCE_REMOVE;
            }),
        ).then(() => {
            if (cancelled) throw Error('qualification cancelled before actor teardown');
        });
    const assert = (condition, message) => {
        if (!condition) throw Error(message);
    };
    const settle = async (predicate) => {
        const start = GLib.get_monotonic_time();
        while (!predicate() && GLib.get_monotonic_time() - start < 3000000) await wait(25);
        assert(predicate(), 'native transaction exceeded bounded recovery');
    };
    const rect = (r) => [r.x, r.y, r.width, r.height];
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const stableBounds = async (window) => {
        let previous = rect(window.get_frame_rect()),
            same = 0;
        for (let i = 0; i < 30; i++) {
            await wait(100);
            const current = rect(window.get_frame_rect());
            same = equal(current, previous) ? same + 1 : 0;
            previous = current;
            if (same >= 4) return current;
        }
        throw Error('native bounds did not settle');
    };
    const extension = Main.extensionManager.lookup(uuid).stateObj;
    const actor = global.get_window_actors().find((a) => extension._matches(a));
    result.profile = {
        purpose: 'intended SSH/PTY/collection/test workload with no concurrent builds',
        events: [],
        loopStalls: [],
        timelineFrames: [],
    };
    const diagnosticNow = () => GLib.get_monotonic_time() / 1000;
    const diagnosticState = () => ({
        timeMs: diagnosticNow(),
        stress: stressActive,
        cycle: resultStress.currentCycle,
        active: extension._active.size,
        frame: rect(actor.meta_window.get_frame_rect()),
        actor: [actor.x, actor.y, actor.width, actor.height],
        stage: [global.stage.width, global.stage.height],
        minimized: actor.meta_window.minimized,
        visible: actor.visible,
        effect: !!actor.get_effect('diagnostic-hub-genie'),
        minimizing: Main.wm._minimizing.has(actor),
        unminimizing: Main.wm._unminimizing.has(actor),
        native: { ...result.native },
    });
    const diagnosticEvent = (event, detail = {}) => {
        result.profile.events.push({ event, ...diagnosticState(), ...detail });
        if (result.profile.events.length > 4096) result.profile.events.splice(0, 512);
    };
    const diagnosticSignals = [];
    for (const name of [
        'size-changed',
        'position-changed',
        'notify::minimized',
        'notify::maximized-horizontally',
    ])
        diagnosticSignals.push([
            actor.meta_window,
            actor.meta_window.connect(name, () => diagnosticEvent(name)),
        ]);
    const diagnosticAnimate = extension._animate;
    extension._animate = function (a, params, direction) {
        if (a !== actor || typeof params.onStopped !== 'function')
            return diagnosticAnimate.call(this, a, params, direction);
        diagnosticEvent('animate-start', { direction });
        const stopped = params.onStopped;
        const observed = {
            ...params,
            onStopped: (...args) => {
                diagnosticEvent('native-onStopped', {
                    direction,
                    stack: String(new Error().stack).slice(0, 800),
                });
                return stopped(...args);
            },
        };
        const accepted = diagnosticAnimate.call(this, a, observed, direction);
        diagnosticEvent('animate-dispatch', { direction, accepted });
        return accepted;
    };
    const diagnosticTimelineStart = Clutter.Timeline.prototype.start;
    const diagnosticTimelines = [];
    Clutter.Timeline.prototype.start = function () {
        if (this.get_actor() === actor) {
            const began = diagnosticNow();
            let previous = began;
            const signals = [
                this.connect('new-frame', () => {
                    const now = diagnosticNow();
                    if (stressActive) {
                        result.profile.timelineFrames.push({
                            timeMs: now,
                            cycle: resultStress.currentCycle,
                            elapsedMs: now - began,
                            gapMs: now - previous,
                            progress: this.get_progress(),
                        });
                        if (result.profile.timelineFrames.length > 8192)
                            result.profile.timelineFrames.splice(0, 1024);
                    }
                    previous = now;
                }),
            ];
            for (const name of ['completed', 'stopped'])
                signals.push(
                    this.connect(name, () =>
                        diagnosticEvent('timeline-' + name, { elapsedMs: diagnosticNow() - began }),
                    ),
                );
            diagnosticTimelines.push([this, signals]);
            diagnosticEvent('timeline-start');
        }
        return diagnosticTimelineStart.call(this);
    };

    const control = global
        .get_window_actors()
        .find((a) => a.meta_window.get_gtk_application_id() === 'dev.diagnostichub.Control');
    result.windows = global.get_window_actors().map((a) => ({
        title: a.meta_window.get_title(),
        class: a.meta_window.get_wm_class(),
        app: Shell.WindowTracker.get_default().get_window_app(a.meta_window)?.get_id(),
    }));
    const traceEnabled = '__TRACE_BOUNDS__' === '1';
    const traceSignals = [];
    result.eventOrder = [];
    const trace = (event, requested = null) => {
        if (!traceEnabled) return;
        result.eventOrder.push({
            event,
            requested,
            timeMs: GLib.get_monotonic_time() / 1000,
            frame: rect(actor.meta_window.get_frame_rect()),
            buffer: rect(actor.meta_window.get_buffer_rect()),
            actor: [actor.x, actor.y, actor.width, actor.height],
            scale: [actor.scale_x, actor.scale_y],
            active: extension._active.size,
            effect: !!actor.get_effect('diagnostic-hub-genie'),
            maximized: actor.meta_window.maximized_horizontally,
            minimized: actor.meta_window.minimized,
        });
        if (result.eventOrder.length > 5000) result.eventOrder.shift();
    };
    if (traceEnabled) {
        for (const signal of [
            'size-changed',
            'position-changed',
            'notify::minimized',
            'notify::maximized-horizontally',
            'notify::maximized-vertically',
        ]) {
            try {
                traceSignals.push([
                    actor.meta_window,
                    actor.meta_window.connect(signal, () => trace(signal)),
                ]);
            } catch {}
        }
        for (const signal of ['minimize', 'unminimize'])
            traceSignals.push([
                global.window_manager,
                global.window_manager.connect(signal, (_wm, a) => {
                    if (a === actor) trace('wm-' + signal);
                }),
            ]);
        trace('trace-start');
    }
    // Observe the actual packaged effects; never insert a qualification render layer.
    const layerEnabled = Config.PACKAGE_VERSION.startsWith('50.');
    const keepLayer = false;
    const layerStats = {
        enabled: true,
        scope: 'production-owned effects only',
        added: 0,
        removed: 0,
    };
    result.productionEffects = layerStats;
    const ownedLayers = new Map();
    const addEffect = actor.add_effect_with_name;
    const removeEffect = actor.remove_effect;
    actor.add_effect_with_name = function (name, effect) {
        const value = addEffect.call(this, name, effect);
        if (
            [
                'diagnostic-hub-genie',
                'diagnostic-hub-genie-bounds',
                'diagnostic-hub-genie-layer',
            ].includes(name)
        ) {
            ownedLayers.set(effect, name);
            layerStats.added++;
        }
        return value;
    };
    actor.remove_effect = function (effect) {
        const value = removeEffect.call(this, effect);
        if (ownedLayers.delete(effect)) layerStats.removed++;
        return value;
    };
    const restoreLayer = () => {
        layerStats.remaining = ownedLayers.size;
        actor.add_effect_with_name = addEffect;
        actor.remove_effect = removeEffect;
    };
    const originals = {};
    let activeControl = false;
    const interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
    const dockSettings = new Gio.Settings({ schema_id: 'org.gnome.shell.extensions.dash-to-dock' });
    const shellSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
    const originalDock = dockSettings.get_enum('dock-position');
    const favorites = shellSettings.get_strv('favorite-apps');
    const animations = interfaceSettings.get_boolean('enable-animations');
    try {
        assert(actor && control, 'actual target and same-title non-target windows are required');
        assert(
            actor.meta_window.get_title() === control.meta_window.get_title(),
            'control title differs',
        );
        assert(
            Shell.WindowTracker.get_default().get_window_app(actor.meta_window).get_id() ===
                'diagnostic-hub.desktop',
            'application identity does not resolve',
        );
        assert(!extension._matches(control), 'non-target control was matched');
        Main.overview.hide();
        actor.meta_window.activate(global.get_current_time());
        actor.meta_window.unmaximize(Meta.MaximizeFlags.BOTH);
        actor.meta_window.move_resize_frame(true, 120, 50, 1100, 760);
        await wait(800);
        // Normalize a client's initial oversized bounds through GNOME before measuring retention.
        actor.meta_window.maximize(Meta.MaximizeFlags.BOTH);
        await wait(600);
        actor.meta_window.unmaximize(Meta.MaximizeFlags.BOTH);
        await wait(600);
        assert(extension._anchor(actor.meta_window), 'real visible app icon is required');
        let originalBounds = rect(actor.meta_window.get_frame_rect());
        for (const name of ['completed_minimize', 'completed_unminimize']) {
            originals[name] = global.window_manager[name];
            result.native[name] = 0;
            global.window_manager[name] = function (windowActor) {
                if (windowActor === actor) result.native[name]++;
                return originals[name].call(this, windowActor);
            };
        }
        const sizeSignal = actor.meta_window.connect('size-changed', () => {
            if (stressActive) result.stress.observedSizeChanges++;
        });
        try {
            paintSignal = global.stage.connect('after-paint', () => {
                const now = GLib.get_monotonic_time();
                if (stressActive && paintPrevious) paintGaps.push((now - paintPrevious) / 1000);
                paintPrevious = stressActive ? now : 0;
            });
        } catch {
            /* Record unavailable paint cadence without inventing a frame rate. */
        }
        const monitor = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (cancelled) return GLib.SOURCE_CONTINUE;
            const now = GLib.get_monotonic_time();
            if (stressActive && loopPrevious) loopGaps.push((now - loopPrevious) / 1000);
            if (stressActive && loopPrevious && (now - loopPrevious) / 1000 > 100) {
                result.profile.loopStalls.push({
                    gapMs: (now - loopPrevious) / 1000,
                    ...diagnosticState(),
                });
                if (result.profile.loopStalls.length > 1024) result.profile.loopStalls.shift();
            }

            loopPrevious = stressActive ? now : 0;
            activeControl ||= !!control.get_effect('diagnostic-hub-genie');
            const effect = actor.get_effect('diagnostic-hub-genie');
            const direction = Main.wm._minimizing.has(actor) ? 'out' : 'in';
            if (
                effect &&
                (!layerEnabled || !stressActive) &&
                (layerEnabled
                    ? effect.progress > 0.08 && effect.progress < 0.99
                    : effect.progress > 0.15 && effect.progress < 0.85) &&
                result.frames.filter(
                    (frame) =>
                        frame.direction === direction &&
                        (!layerEnabled || frame.edge === effect.edge),
                ).length < 4 &&
                (!layerEnabled ||
                    [0.2, 0.5, 0.8, 0.95].some(
                        (p) => Math.abs(p - effect.progress) < (p === 0.95 ? 0.035 : 0.07),
                    )) &&
                !result.frames.some(
                    (frame) =>
                        frame.direction === direction &&
                        (!layerEnabled || frame.edge === effect.edge) &&
                        Math.abs(frame.progress - effect.progress) < (layerEnabled ? 0.13 : 0.08),
                )
            ) {
                const filename = destination + '.' + result.frames.length + '.xwd';
                result.frames.push({
                    direction,
                    progress: effect.progress,
                    edge: effect.edge,
                    source: effect.source,
                    target: effect.target,
                    effectTargetSize: effect.get_target_size(),
                    effectTextureSize: effect.get_texture()
                        ? [effect.get_texture().get_width(), effect.get_texture().get_height()]
                        : null,
                    visible: actor.visible,
                    size: [actor.width, actor.height],
                    paintOpacity: actor.get_paint_opacity(),
                    children: actor.get_children().map((c) => ({
                        type: c.constructor.name,
                        visible: c.visible,
                        mapped: c.mapped,
                        width: c.width,
                        height: c.height,
                    })),
                    mapped: actor.mapped,
                    opacity: actor.opacity,
                });
                const index = result.frames.length - 1;
                if (exportTextures && [0, 4].includes(index)) {
                    const observation = result.frames[index];
                    const texture = effect.get_texture();
                    if (texture) {
                        const stream = Gio.MemoryOutputStream.new_resizable();
                        textureExports.push(
                            Shell.Screenshot.composite_to_stream(
                                texture,
                                0,
                                0,
                                -1,
                                -1,
                                1,
                                null,
                                0,
                                0,
                                1,
                                stream,
                            )
                                .then(() => {
                                    stream.close(null);
                                    const bytes = stream.steal_as_bytes();
                                    Gio.File.new_for_path(
                                        destination + '.' + index + '.texture.png',
                                    ).replace_contents(
                                        bytes.get_data(),
                                        null,
                                        false,
                                        Gio.FileCreateFlags.REPLACE_DESTINATION,
                                        null,
                                    );
                                    observation.textureExport = 'written';
                                })
                                .catch((error) => {
                                    observation.textureExportError = String(error);
                                }),
                        );
                    }
                }
                // Capture the actual outer output, not Shell.Screenshot (which can omit effects).
                const captureStarted = GLib.get_monotonic_time();
                if (layerEnabled) {
                    const [, , , status] = GLib.spawn_sync(
                        null,
                        ['xwd', '-root', '-silent', '-out', filename],
                        null,
                        GLib.SpawnFlags.SEARCH_PATH,
                        null,
                    );
                    assert(status === 0, 'synchronous visual capture failed');
                    result.frames[index].captureMs =
                        (GLib.get_monotonic_time() - captureStarted) / 1000;
                } else {
                    GLib.spawn_async(
                        null,
                        ['xwd', '-root', '-silent', '-out', filename],
                        null,
                        GLib.SpawnFlags.SEARCH_PATH,
                        null,
                    );
                }
            }
            return GLib.SOURCE_CONTINUE;
        });
        try {
            if (stressEnabled) {
                stressActive = true;
                global.hubQualificationStressActive = true;
                loopPrevious = GLib.get_monotonic_time();
                const resize = async (width, height) => {
                    const bounds = actor.meta_window.get_frame_rect();
                    trace('request-resize', [bounds.x, bounds.y, width, height]);
                    actor.meta_window.move_resize_frame(true, bounds.x, bounds.y, width, height);
                    result.stress.resizeRequests++;
                    await wait(25);
                };
                for (let cycle = 0; cycle < 100; cycle++) {
                    const before = { ...result.native };
                    result.stress.currentCycle = cycle;
                    result.stress.nativeBeforeCycle = before;
                    const started = GLib.get_monotonic_time();
                    actor.meta_window.minimize();
                    actor.meta_window.minimize(); // Repeated action must not duplicate completion.
                    await wait(35);
                    await resize(1080 + (cycle % 3) * 10, 730);
                    await resize(1120, 770);
                    actor.meta_window.activate(global.get_current_time());
                    await wait(35);
                    await resize(1090, 740);
                    await resize(1100, 760);
                    if (cycle % 10 === 9) {
                        actor.meta_window.maximize(Meta.MaximizeFlags.BOTH);
                        await wait(40);
                        actor.meta_window.unmaximize(Meta.MaximizeFlags.BOTH);
                        await wait(40);
                    }
                    if (cycle % 5 === 4) {
                        control.meta_window.activate(global.get_current_time());
                        await wait(25);
                        actor.meta_window.activate(global.get_current_time());
                    }
                    await settle(
                        () =>
                            result.native.completed_unminimize >= before.completed_unminimize + 1 &&
                            extension._active.size === 0,
                    );
                    assert(
                        result.native.completed_minimize === before.completed_minimize + 1,
                        'stress minimize completion duplicated or lost',
                    );
                    assert(
                        result.native.completed_unminimize === before.completed_unminimize + 1,
                        'stress restore completion duplicated or lost',
                    );
                    assert(
                        !actor.meta_window.minimized &&
                            actor.visible &&
                            actor.opacity === 255 &&
                            !actor.get_effect('diagnostic-hub-genie'),
                        'stress left a stuck or unusable actor',
                    );
                    recoveryTimes.push((GLib.get_monotonic_time() - started) / 1000);
                    assert(
                        recoveryTimes.at(-1) < 3000,
                        'stress native recovery exceeded 3 seconds',
                    );
                    result.stress.cycles++;
                }
                stressActive = false;
                originalBounds = await stableBounds(actor.meta_window);
                assert(result.stress.resizeRequests >= 200, 'insufficient stress resize requests');
                assert(
                    result.stress.observedSizeChanges >= 200,
                    'insufficient actual size-change events',
                );
                result.stress.recoveryMs = summarize(recoveryTimes);
                result.stress.compositorLoopGapMs = summarize(loopGaps);
                result.stress.paintGapMs = summarize(paintGaps);
                result.stress.paintCadenceAvailable = paintSignal !== 0;
                result.stress.criteria = { recoveryMaxMs: 3000, compositorLoopP95Ms: 100 };
                assert(
                    result.stress.compositorLoopGapMs.p95 <= 100,
                    'stress compositor loop p95 exceeded 100 ms',
                );
                result.stress.ok = true;
                result.checks.push(
                    '100-interrupted-resize-stress-cycles',
                    '400-rapid-resize-requests',
                    'measured-recovery-and-compositor-responsiveness',
                );
            }
            for (let cycle = 0; cycle < 100; cycle++) {
                const before = { ...result.native };
                actor.meta_window.minimize();
                await wait(cycle % 10 === 9 ? 80 : 580);
                if (cycle % 10 === 9) {
                    const r = actor.meta_window.get_frame_rect();
                    trace('request-resize', [r.x, r.y, 1100, 760]);
                    actor.meta_window.move_resize_frame(true, r.x, r.y, 1100, 760);
                }
                actor.meta_window.activate(global.get_current_time());
                await settle(
                    () =>
                        result.native.completed_unminimize >= before.completed_unminimize + 1 &&
                        extension._active.size === 0,
                );
                if (cycle % 10 === 9) originalBounds = await stableBounds(actor.meta_window);
                assert(
                    result.native.completed_minimize === before.completed_minimize + 1,
                    'minimize did not complete exactly once',
                );
                assert(
                    result.native.completed_unminimize === before.completed_unminimize + 1,
                    'restore did not complete exactly once',
                );
                assert(
                    !actor.meta_window.minimized && actor.visible && actor.opacity === 255,
                    'native actor did not recover',
                );
                assert(
                    extension._active.size === 0 && !actor.get_effect('diagnostic-hub-genie'),
                    'owned effect/timeline retained',
                );
                assert(
                    equal(rect(actor.meta_window.get_frame_rect()), originalBounds),
                    'normal bounds changed: ' +
                        JSON.stringify({
                            cycle,
                            originalBounds,
                            actual: rect(actor.meta_window.get_frame_rect()),
                        }),
                );
                result.cycles++;
            }
            control.meta_window.minimize();
            await wait(580);
            control.meta_window.activate(global.get_current_time());
            await wait(580);
            assert(!activeControl, 'same-title control received the effect');
            result.checks.push(
                `${result.cycles}-native-cycles`,
                'rapid-reversal',
                'normal-bounds',
                'target-isolation',
                'idle-cleanup',
            );
            actor.meta_window.maximize(Meta.MaximizeFlags.BOTH);
            await wait(600);
            actor.meta_window.unmaximize(Meta.MaximizeFlags.BOTH);
            await wait(600);
            const geometry = (phase) => {
                result.boundsObservations ??= [];
                result.boundsObservations.push({
                    phase,
                    frame: rect(actor.meta_window.get_frame_rect()),
                    buffer: rect(actor.meta_window.get_buffer_rect()),
                    actor: [actor.x, actor.y, actor.width, actor.height],
                    actorScale: [actor.scale_x, actor.scale_y],
                    active: extension._active.size,
                    maximized: actor.meta_window.maximized_horizontally,
                    minimized: actor.meta_window.minimized,
                });
            };
            const originalNormal = await stableBounds(actor.meta_window);
            geometry('original-normal');
            // Control the same compositor remap without our effect: Wayland CSD extents may
            // appear only after a maximized surface has been remapped.
            extension._enabled = false;
            actor.meta_window.maximize(Meta.MaximizeFlags.BOTH);
            await wait(600);
            actor.meta_window.minimize();
            await wait(600);
            actor.meta_window.activate(global.get_current_time());
            await wait(600);
            actor.meta_window.unmaximize(Meta.MaximizeFlags.BOTH);
            await wait(600);
            const nativeNormal = await stableBounds(actor.meta_window);
            geometry('after-native-normal');
            extension._enabled = true;
            result.nativeBounds = { beforeRemap: originalNormal, afterNativeRemap: nativeNormal };
            actor.meta_window.maximize(Meta.MaximizeFlags.BOTH);
            await wait(600);
            geometry('effect-maximized');
            const maximizedBounds = rect(actor.meta_window.get_frame_rect());
            actor.meta_window.minimize();
            await wait(580);
            actor.meta_window.activate(global.get_current_time());
            await wait(600);
            assert(
                actor.meta_window.maximized_horizontally &&
                    actor.meta_window.maximized_vertically &&
                    equal(rect(actor.meta_window.get_frame_rect()), maximizedBounds),
                'maximized bounds changed',
            );
            actor.meta_window.unmaximize(Meta.MaximizeFlags.BOTH);
            await wait(600);
            await stableBounds(actor.meta_window);
            geometry('effect-after-normal');
            assert(
                equal(rect(actor.meta_window.get_frame_rect()), nativeNormal),
                'saved normal bounds differ from native control: ' +
                    JSON.stringify({
                        nativeNormal,
                        actual: rect(actor.meta_window.get_frame_rect()),
                    }),
            );
            result.checks.push('maximized-and-saved-bounds');
            // All settings and icon moves affect only this disposable session.
            for (const [position, edge] of [
                [0, 'top'],
                [1, 'right'],
                [2, 'bottom'],
                [3, 'left'],
            ]) {
                dockSettings.set_enum('dock-position', position);
                shellSettings.set_strv('favorite-apps', [
                    'org.gnome.Shell.Extensions.desktop',
                    'diagnostic-hub.desktop',
                ]);
                await wait(600);
                const outgoing = extension._anchor(actor.meta_window);
                actor.meta_window.minimize();
                await wait(90);
                const outEffect = actor.get_effect('diagnostic-hub-genie');
                assert(
                    outEffect?.edge === edge && equal(outEffect.target, outgoing),
                    'native dock edge/anchor was incorrect',
                );
                await wait(520);
                dockSettings.set_enum('dock-position', (position + 1) % 4);
                shellSettings.set_strv('favorite-apps', [
                    'diagnostic-hub.desktop',
                    'org.gnome.Shell.Extensions.desktop',
                ]);
                await wait(600);
                const incoming = extension._anchor(actor.meta_window);
                assert(!equal(incoming, outgoing), 'real dock relocation did not change anchor');
                // Activating the app can relayout the dock. Observe geometry at the actual
                // native hook, rather than comparing it to a different frame 90 ms later.
                const readAnchor = extension._anchor;
                let nativeIncoming;
                extension._anchor = function (window) {
                    const value = readAnchor.call(this, window);
                    if (window === actor.meta_window && Main.wm._unminimizing.has(actor))
                        nativeIncoming = value;
                    return value;
                };
                try {
                    actor.meta_window.activate(global.get_current_time());
                    await wait(90);
                } finally {
                    extension._anchor = readAnchor;
                }
                const inEffect = actor.get_effect('diagnostic-hub-genie');
                assert(
                    inEffect && nativeIncoming && equal(inEffect.target, nativeIncoming),
                    'restore anchor differs from the live icon: ' +
                        JSON.stringify({
                            incoming,
                            effect: inEffect?.target,
                            nativeIncoming,
                        }),
                );
                await wait(520);
            }
            dockSettings.set_enum('dock-position', originalDock);
            shellSettings.set_strv('favorite-apps', favorites);
            await wait(600);
            result.checks.push(
                'four-native-dock-edges',
                'fresh-restore-after-relocation',
                'icon-reorder',
            );
            interfaceSettings.set_boolean('enable-animations', false);
            actor.meta_window.minimize();
            await wait(200);
            assert(!actor.get_effect('diagnostic-hub-genie'), 'reduced motion was ignored');
            actor.meta_window.activate(global.get_current_time());
            await wait(300);
            interfaceSettings.set_boolean('enable-animations', true);
            result.checks.push('reduced-motion');
            const route = Clutter.Actor.prototype.ease;
            const foreign = function (params) {
                return route.call(this, params);
            };
            Clutter.Actor.prototype.ease = foreign;
            try {
                actor.meta_window.minimize();
                await wait(200);
                assert(!actor.get_effect('diagnostic-hub-genie'), 'foreign route was overridden');
                actor.meta_window.activate(global.get_current_time());
                await wait(400);
            } finally {
                Clutter.Actor.prototype.ease = route;
            }
            result.checks.push('conflicting-route-fallback');
            actor.meta_window.minimize();
            await wait(80);
            Main.extensionManager._callExtensionDisable(uuid);
            await wait(200);
            actor.meta_window.activate(global.get_current_time());
            await wait(500);
            assert(
                !actor.meta_window.minimized &&
                    actor.visible &&
                    !actor.get_effect('diagnostic-hub-genie') &&
                    extension._active.size === 0,
                'disable left an unusable actor',
            );
            assert(Clutter.Actor.prototype.ease !== route, 'disable retained its global hook');
            result.checks.push('disable-during-native-motion');
            assert(ownedLayers.size === 0, 'private render layer retained after disable');
            assert(
                layerStats.added === layerStats.removed,
                'production owned effect lifetime mismatch',
            );
            assert(result.frames.length >= 2, 'no intermediate production deformation frames');
            result.ok = true;
        } finally {
            GLib.source_remove(monitor);
            actor.meta_window.disconnect(sizeSignal);
            if (paintSignal) global.stage.disconnect(paintSignal);
        }
    } catch (error) {
        result.stress.partialRecoveryMs = summarize(recoveryTimes);
        result.stress.partialCompositorLoopGapMs = summarize(loopGaps);
        result.stress.partialPaintGapMs = summarize(paintGaps);
        result.ok = false;
        result.error = String(error) + '\n' + String(error.stack ?? '');
        try {
            result.failureActor = {
                frame: rect(actor.meta_window.get_frame_rect()),
                buffer: rect(actor.meta_window.get_buffer_rect()),
                mapped: actor.mapped,
                visible: actor.visible,
                minimized: actor.meta_window.minimized,
                opacity: actor.get_paint_opacity(),
                active: extension._active.size,
                effects: actor.get_effects().map((e) => e.get_name()),
                minimizing: Main.wm._minimizing.has(actor),
                unminimizing: Main.wm._unminimizing.has(actor),
            };
        } catch (snapshotError) {
            result.failureSnapshotError = String(snapshotError);
        }
    } finally {
        result.profile.final = diagnosticState();
        extension._animate = diagnosticAnimate;
        Clutter.Timeline.prototype.start = diagnosticTimelineStart;
        for (const [object, id] of diagnosticSignals) object.disconnect(id);
        for (const [timeline, ids] of diagnosticTimelines)
            for (const id of ids)
                try {
                    timeline.disconnect(id);
                } catch {}
        layerStats.remaining = ownedLayers.size;
        restoreLayer();
        trace('trace-end');
        for (const [object, id] of traceSignals) object.disconnect(id);
        await Promise.all(textureExports);
        delete global.hubQualificationCancel;
        delete global.hubQualificationStressActive;
        for (const [name, method] of Object.entries(originals))
            global.window_manager[name] = method;
        interfaceSettings.set_boolean('enable-animations', animations);
        dockSettings.set_enum('dock-position', originalDock);
        shellSettings.set_strv('favorite-apps', favorites);
        Gio.File.new_for_path(destination).replace_contents(
            JSON.stringify(result),
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null,
        );
    }
})();
