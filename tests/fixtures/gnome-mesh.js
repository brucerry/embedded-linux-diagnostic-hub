void (async () => {
    const { default: GLib } = await import('gi://GLib');
    const { default: Gio } = await import('gi://Gio');
    const { default: Clutter } = await import('gi://Clutter');
    const { default: GObject } = await import('gi://GObject');
    const { default: Shell } = await import('gi://Shell');
    const { default: St } = await import('gi://St');
    const Main = await import('resource:///org/gnome/shell/ui/main.js');
    const { default: Meta } = await import('gi://Meta');
    const ext = Main.extensionManager.lookup('diagnostic-hub-genie@diagnostichub.desktop').stateObj;
    const actor = global.get_window_actors().find((a) => ext._matches(a));
    const win = actor.meta_window;
    const wait = (ms) =>
        new Promise((resolve) =>
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            }),
        );
    const report = {
        ok: false,
        scope: 'diagnostic identity/deformed meshes and repaint, not native qualification',
        phases: [],
    };
    const effectName = 'hub-diagnostic-mesh';
    let widget;
    const Mesh = GObject.registerClass(
        class HubQualificationMesh extends Clutter.DeformEffect {
            _init(mode) {
                super._init();
                this.mode = mode;
                this.calls = 0;
                this.invalid = 0;
                this.samples = [];
                this.set_n_tiles(12, 16);
            }
            vfunc_paint_target(node, context) {
                if (this.mode === 'flat')
                    return Clutter.OffscreenEffect.prototype.vfunc_paint_target.call(
                        this,
                        node,
                        context,
                    );
                return super.vfunc_paint_target(node, context);
            }
            vfunc_deform_vertex(w, h, v) {
                if (this.samples.length < 3)
                    this.samples.push({
                        w,
                        h,
                        x: v.x,
                        y: v.y,
                        z: v.z,
                        tx: v.tx,
                        ty: v.ty,
                        alpha: v.color.get_alpha(),
                    });
                this.calls++;
                if (![w, h, v.x, v.y, v.tx, v.ty].every(Number.isFinite)) this.invalid++;
                if (this.mode !== 'identity') {
                    v.x = w * 0.25 + v.tx * w * 0.5;
                    v.y = h * 0.25 + v.ty * h * 0.5;
                }
                if (this.mode === 'depth-offset') v.z = 10;
            }
        },
    );
    const snap = async (label, a, e) => {
        let paints = 0;
        const id = global.stage.connect('after-paint', () => paints++);
        a.queue_redraw();
        const begin = GLib.get_monotonic_time();
        try {
            while (
                (paints < 1 || (e && e.mode !== 'flat' && e.calls < 1)) &&
                GLib.get_monotonic_time() - begin < 5000000
            )
                await wait(50);
        } finally {
            global.stage.disconnect(id);
        }
        await wait(250);
        const phase = {
            label,
            paints,
            paintDeadlineMet: paints >= 1 && (!e || e.mode === 'flat' || e.calls > 0),
            frame: a.meta_window
                ? (() => {
                      let r = a.meta_window.get_frame_rect();
                      return [r.x, r.y, r.width, r.height];
                  })()
                : null,
            actor: [a.x, a.y, a.width, a.height],
            mapped: a.mapped,
            visible: a.visible,
            opacity: a.get_paint_opacity(),
            calls: e?.calls,
            invalid: e?.invalid,
            samples: e?.samples,
            children: a.get_children().map((c) => ({
                type: c.constructor.name,
                visible: c.visible,
                mapped: c.mapped,
                size: [c.width, c.height],
            })),
        };
        report.phases.push(phase);
        GLib.spawn_command_line_sync('xwd -root -silent -out __OUTPUT__/' + label + '.xwd');
        const texture = e?.get_texture();
        if (texture) {
            const stream = Gio.MemoryOutputStream.new_resizable();
            await Shell.Screenshot.composite_to_stream(
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
            );
            stream.close(null);
            Gio.File.new_for_path('__OUTPUT__/' + label + '.texture.png').replace_contents(
                stream.steal_as_bytes().get_data(),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null,
            );
            phase.texture = [texture.get_width(), texture.get_height()];
        }
    };
    const attach = async (label, a, mode) => {
        const e = new Mesh(mode);
        a.add_effect_with_name(effectName, e);
        a.queue_redraw();
        await snap(label, a, e);
        a.remove_effect(e);
        await wait(200);
    };
    try {
        ext._enabled = false;
        Main.overview.hide();
        win.activate(global.get_current_time());
        win.unmaximize(Meta.MaximizeFlags.BOTH);
        win.move_resize_frame(true, 120, 50, 1100, 760);
        await snap('baseline', actor);
        await attach('window-flat-offscreen', actor, 'flat');
        await attach('window-identity', actor, 'identity');
        await attach('window-half-mesh', actor, 'half');
        await attach('window-depth-offset', actor, 'depth-offset');
        await snap('after-remove', actor);
        win.minimize();
        await wait(600);
        win.activate(global.get_current_time());
        await snap('native-restore-baseline', actor);
        await attach('restore-identity', actor, 'identity');
        const redraw = (a) => {
            a.queue_redraw();
            for (const c of a.get_children()) redraw(c);
        };
        redraw(actor);
        await attach('restore-recursive-redraw', actor, 'identity');
        widget = new St.Widget({
            style: 'background-color: rgb(230,30,200);',
            x: 40,
            y: 70,
            width: 260,
            height: 200,
        });
        Main.uiGroup.add_child(widget);
        await snap('widget-baseline', widget);
        await attach('widget-flat-offscreen', widget, 'flat');
        await attach('widget-identity', widget, 'identity');
        await attach('widget-half-mesh', widget, 'half');
        report.ok = true;
    } catch (error) {
        report.error = String(error) + '\n' + String(error.stack);
    } finally {
        actor.remove_effect_by_name(effectName);
        widget?.destroy();
        ext._enabled = true;
        Gio.File.new_for_path('__OUTPUT__/mesh.json').replace_contents(
            JSON.stringify(report),
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null,
        );
    }
})();
