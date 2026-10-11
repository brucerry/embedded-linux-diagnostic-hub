void (async () => {
    const { default: GLib } = await import('gi://GLib');
    const { default: Gio } = await import('gi://Gio');
    const { default: Clutter } = await import('gi://Clutter');
    const { default: Cogl } = await import('gi://Cogl');
    const { default: GObject } = await import('gi://GObject');
    const { default: St } = await import('gi://St');
    const Main = await import('resource:///org/gnome/shell/ui/main.js');
    const report = {
        ok: false,
        scope: 'diagnostic isolated solid actor stage depth/clip controls, not Genie qualification',
        phases: [],
    };
    const wait = (ms) =>
        new Promise((resolve) =>
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            }),
        );
    let widget;
    const Wrapper = GObject.registerClass(
        class HubStageOffscreen extends Clutter.OffscreenEffect {},
    );
    const Mesh = GObject.registerClass(
        class HubStageControl extends Clutter.DeformEffect {
            _init(mode) {
                super._init();
                this.mode = mode;
                this.calls = 0;
                this.paintTargets = 0;
                this.set_n_tiles(12, 16);
            }
            vfunc_deform_vertex(w, h, v) {
                this.calls++;
                v.x = w * 0.25 + v.tx * w * 0.5;
                v.y = h * 0.25 + v.ty * h * 0.5;
            }
            vfunc_paint_target(node, context) {
                this.paintTargets++;
                const pipeline = this.get_pipeline();
                const fb = context.get_framebuffer();
                this.framebuffer = {
                    size: [fb.get_width(), fb.get_height()],
                    depthWrite: fb.get_depth_write_enabled(),
                };
                if (this.mode.includes('depth-clear')) {
                    const prior = fb.get_depth_write_enabled();
                    this.clearAttempt = true;
                    try {
                        fb.set_depth_write_enabled(true);
                        fb.clear4f(Cogl.BufferBit.DEPTH, 0, 0, 0, 0);
                    } finally {
                        fb.set_depth_write_enabled(prior);
                    }
                }
                if (this.mode.startsWith('flat')) {
                    const depth = new Cogl.DepthState();
                    depth.init();
                    depth.set_test_enabled(this.mode !== 'flat');
                    depth.set_test_function(
                        this.mode === 'flat-depth-gequal'
                            ? Cogl.DepthTestFunction.GEQUAL
                            : this.mode === 'flat-depth-always'
                              ? Cogl.DepthTestFunction.ALWAYS
                              : Cogl.DepthTestFunction.LEQUAL,
                    );
                    pipeline.set_depth_state(depth);
                    return Clutter.OffscreenEffect.prototype.vfunc_paint_target.call(
                        this,
                        node,
                        context,
                    );
                }
                if (this.mode === 'mesh-color-white' && !this.addedColor) {
                    this.addedColor = true;
                    pipeline.add_snippet(
                        Cogl.Snippet.new(
                            Cogl.SnippetHook.VERTEX,
                            '',
                            'cogl_color_out = vec4(1.0);',
                        ),
                    );
                }
                if (this.mode === 'mesh-z-zero' && !this.addedPosition) {
                    this.addedPosition = true;
                    pipeline.add_snippet(
                        Cogl.Snippet.new(
                            Cogl.SnippetHook.VERTEX_TRANSFORM,
                            '',
                            'cogl_position_out.z = 0.0;',
                        ),
                    );
                }
                return super.vfunc_paint_target(node, context);
            }
        },
    );
    try {
        Main.overview.hide();
        widget = new St.Widget({
            style: 'background-color: rgb(230,30,200);',
            x: 40,
            y: 70,
            width: 260,
            height: 200,
        });
        Main.uiGroup.add_child(widget);
        for (const mode of [
            'flat',
            'flat-depth-lequal',
            'mesh',
            'mesh-wrapped',
            'mesh-after-wrapper',
        ]) {
            const effect = mode === 'baseline' ? null : new Mesh(mode);
            const wrapper = mode === 'mesh-wrapped' ? new Wrapper() : null;
            if (wrapper) widget.add_effect_with_name('hub-stage-wrapper', wrapper);
            if (mode === 'mesh-no-clip') widget.set_clip_to_allocation(false);
            if (effect) widget.add_effect_with_name('hub-stage-control', effect);
            let paints = 0;
            const id = global.stage.connect('after-paint', () => paints++);
            widget.queue_redraw();
            const begin = GLib.get_monotonic_time();
            while (
                (paints < 1 || (effect && effect.paintTargets < 1)) &&
                GLib.get_monotonic_time() - begin < 5000000
            )
                await wait(50);
            global.stage.disconnect(id);
            await wait(250);
            report.phases.push({
                mode,
                wrapped: Boolean(wrapper),
                paints,
                paintTargets: effect?.paintTargets,
                calls: effect?.calls,
                framebuffer: effect?.framebuffer,
                mapped: widget.mapped,
                visible: widget.visible,
                clip: typeof widget.has_clip === 'function' ? widget.has_clip() : widget.has_clip,
                clipToAllocation: widget.get_clip_to_allocation(),
                opacity: widget.get_paint_opacity(),
                parents: [widget.get_parent(), widget.get_parent()?.get_parent()]
                    .filter(Boolean)
                    .map((a) => ({
                        type: a.constructor.name,
                        clip: typeof a.has_clip === 'function' ? a.has_clip() : a.has_clip,
                        clipToAllocation: a.get_clip_to_allocation(),
                        opacity: a.get_paint_opacity(),
                    })),
            });
            GLib.spawn_command_line_sync(
                'xwd -root -silent -out __OUTPUT__/stage-' + mode + '.xwd',
            );
            if (effect) widget.remove_effect(effect);
            if (wrapper) widget.remove_effect(wrapper);
            await wait(150);
        }
        report.ok = report.phases.every(
            (p) => p.paints > 0 && p.mapped && (!p.paintTargets || p.paintTargets > 0),
        );
    } catch (error) {
        report.error = String(error) + '\n' + String(error.stack);
    } finally {
        widget?.destroy();
        Gio.File.new_for_path('__OUTPUT__/mesh.json').replace_contents(
            JSON.stringify(report),
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null,
        );
    }
})();
