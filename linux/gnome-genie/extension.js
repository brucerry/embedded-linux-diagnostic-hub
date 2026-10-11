import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import {
    APPLICATION_ID,
    WINDOW_CLASS,
    SHELL_MAJORS,
    anchorEdge,
    rectangle,
    deform,
} from './geometry.js';
import { BUILD } from './build-info.js';

const EFFECT_NAME = 'diagnostic-hub-genie';
const LAYERED_RENDERING = Number(Config.PACKAGE_VERSION.split('.')[0]) === 50;
const STATUS_PATH = '/dev/diagnostichub/Genie';
const STATUS_XML = `<node><interface name="dev.diagnostichub.Genie1">
    <method name="GetStatus"><arg name="status" type="s" direction="out"/></method>
</interface></node>`;

const Deformation = GObject.registerClass(
    class DiagnosticHubDeformation extends Clutter.DeformEffect {
        _init(source, target, edge, progress) {
            super._init();
            this.source = source;
            this.target = target;
            this.edge = edge;
            this.progress = progress;
            this.set_n_tiles(24, 32);
        }

        vfunc_deform_vertex(width, height, vertex) {
            const canvas = this.canvas;
            if (canvas && (width !== canvas.width || height !== canvas.height)) {
                // A changed offscreen allocation must recover through the native completion path.
                this.renderInvalid = true;
                return;
            }
            const tx = canvas
                ? Math.max(0, Math.min(1, (canvas.x + vertex.tx * width) / this.source.width))
                : vertex.tx;
            const ty = canvas
                ? Math.max(0, Math.min(1, (canvas.y + vertex.ty * height) / this.source.height))
                : vertex.ty;
            const point = deform(this.source, this.target, this.edge, this.progress, tx, ty);
            vertex.x = point.x - (canvas?.x ?? 0);
            vertex.y = point.y - (canvas?.y ?? 0);
        }
    },
);

// GNOME50 deforms in an actor-owned framebuffer, with the complete dock trajectory
// inside its paint volume. The expanded trajectory also requires stage-view invalidation.
const DeformationLayer = LAYERED_RENDERING
    ? GObject.registerClass(class DiagnosticHubDeformationLayer extends Clutter.OffscreenEffect {})
    : null;
const DeformationBounds = LAYERED_RENDERING
    ? GObject.registerClass(
          class DiagnosticHubDeformationBounds extends Clutter.Effect {
              _init(effect) {
                  super._init();
                  this.effect = effect;
              }

              vfunc_modify_paint_volume(volume) {
                  const source = this.effect.source;
                  const target = this.effect.target;
                  const origin = volume.get_origin();
                  const x = Math.floor(Math.min(origin.x, target.x - source.x - 2));
                  const y = Math.floor(Math.min(origin.y, target.y - source.y - 2));
                  const right = Math.ceil(
                      Math.max(
                          origin.x + volume.get_width(),
                          target.x + target.width - source.x + 2,
                      ),
                  );
                  const bottom = Math.ceil(
                      Math.max(
                          origin.y + volume.get_height(),
                          target.y + target.height - source.y + 2,
                      ),
                  );
                  volume.set_origin(new Graphene.Point3D({ x, y, z: origin.z }));
                  volume.set_width(right - x);
                  volume.set_height(bottom - y);
                  // The qualified scale1 GNOME50 offscreen box includes integer raster padding.
                  // Deformation checks the resulting dimensions before using these coordinates.
                  this.effect.canvas = {
                      x: x - 2,
                      y: y - 2,
                      width: right - x + 3,
                      height: bottom - y + 3,
                  };
                  return true;
              }
          },
      )
    : null;

export default class DiagnosticHubGenie extends Extension {
    enable() {
        this._active = new Map();
        this._signals = [];
        this._enabled = true;
        this._settings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        this._capable =
            SHELL_MAJORS.includes(Number(Config.PACKAGE_VERSION.split('.')[0])) &&
            Main.wm._minimizing instanceof Set &&
            Main.wm._unminimizing instanceof Set &&
            typeof Clutter.Actor.prototype.ease === 'function' &&
            Function.prototype.toString
                .call(Clutter.Actor.prototype.ease)
                .includes('_easeActor(') &&
            typeof Clutter.Timeline.prototype.start === 'function';
        this._capable &&=
            typeof global.begin_work === 'function' &&
            typeof global.end_work === 'function' &&
            ((typeof Meta.disable_unredirect_for_display === 'function' &&
                typeof Meta.enable_unredirect_for_display === 'function') ||
                (typeof global.compositor?.disable_unredirect === 'function' &&
                    typeof global.compositor?.enable_unredirect === 'function'));
        this._metaUnredirect =
            typeof Meta.disable_unredirect_for_display === 'function' &&
            typeof Meta.enable_unredirect_for_display === 'function';
        const original = Clutter.Actor.prototype.ease;
        this._original = original;
        const extension = this;
        this._wrapper = function (params) {
            if (
                extension._enabled &&
                extension._capable &&
                Clutter.Actor.prototype.ease === extension._wrapper &&
                extension._diskCurrent() &&
                extension._settings.get_boolean('enable-animations')
            ) {
                const direction = Main.wm._minimizing.has(this)
                    ? 'out'
                    : Main.wm._unminimizing.has(this)
                      ? 'in'
                      : null;
                if (direction && extension._matches(this)) {
                    try {
                        if (extension._animate(this, params, direction)) return;
                    } catch (error) {
                        const transaction = extension._active.get(this);
                        if (transaction) {
                            transaction.finish();
                            return;
                        }
                        console.error('Diagnostic Hub Genie: native fallback', error);
                    }
                }
            }
            return original.call(this, params);
        };
        if (this._capable) Clutter.Actor.prototype.ease = this._wrapper;
        this._connect(
            global.window_manager,
            'kill-window-effects',
            (_wm, actor) => {
                this._active.get(actor)?.finish();
            },
            true,
        );
        this._connect(this._settings, 'changed::enable-animations', () => {
            if (!this._settings.get_boolean('enable-animations')) this._finishAll();
        });
        this._connect(Main.layoutManager, 'monitors-changed', () => this._finishAll());
        this._status = Gio.DBusExportedObject.wrapJSObject(STATUS_XML, {
            GetStatus: () =>
                JSON.stringify({
                    ...BUILD,
                    applicationId: APPLICATION_ID,
                    active:
                        this._enabled &&
                        this._capable &&
                        Clutter.Actor.prototype.ease === this._wrapper &&
                        this._diskCurrent(),
                    animations: this._settings.get_boolean('enable-animations'),
                    capabilities: this._capable
                        ? ['native-minimize', 'native-restore', 'fresh-anchor', 'bounded-cleanup']
                        : [],
                }),
        });
        this._status.export(Gio.DBus.session, STATUS_PATH);
    }

    _connect(object, name, callback, after = false) {
        const id = after ? object.connect_after(name, callback) : object.connect(name, callback);
        this._signals.push([object, id]);
    }

    _diskCurrent() {
        try {
            const [ok, bytes] = Gio.File.new_for_path(`${this.path}/metadata.json`).load_contents(
                null,
            );
            if (!ok) return false;
            const metadata = JSON.parse(new TextDecoder().decode(bytes));
            if (BUILD.version === 'development') return metadata['version-name'] === 'development';
            const installed = metadata['diagnostic-hub'];
            return (
                installed?.version === BUILD.version &&
                installed.commit === BUILD.commit &&
                installed.sourceHash === BUILD.sourceHash
            );
        } catch {
            return false;
        }
    }

    _matches(actor) {
        const window = actor.meta_window;
        if (!window || window.get_wm_class()?.toLowerCase() !== WINDOW_CLASS) return false;
        return (
            Shell.WindowTracker.get_default().get_window_app(window)?.get_id() === APPLICATION_ID
        );
    }

    _anchor(window) {
        // A known but hidden dash must not authorize its stale recorded geometry.
        const matches =
            Main.overview.dash?._box
                ?.get_children()
                .filter((child) => child.child?._delegate?.app?.get_id() === APPLICATION_ID) ?? [];
        if (matches.length > 1) return null;
        if (matches.length === 1) {
            const actor = matches[0].child;
            if (!actor.visible || !actor.mapped) return null;
            const [x, y] = actor.get_transformed_position();
            const [width, height] = actor.get_transformed_size();
            const rect = rectangle({ x, y, width, height });
            return rect && anchorEdge(rect, Main.layoutManager.monitors) ? rect : null;
        }
        const [found, geometry] = window.get_icon_geometry();
        const rect = found ? rectangle(geometry) : null;
        return rect && anchorEdge(rect, Main.layoutManager.monitors) ? rect : null;
    }

    _animate(actor, params, direction) {
        if (typeof params.onStopped !== 'function') return false;
        this._active.get(actor)?.finish();
        if (actor.get_effects().length) return false;
        const source = rectangle(actor.meta_window.get_buffer_rect());
        const target = this._anchor(actor.meta_window);
        const edge = target && anchorEdge(target, Main.layoutManager.monitors);
        if (!source || !target || !edge || !actor.mapped) return false;
        const layered = LAYERED_RENDERING;
        if (layered && actor.get_resource_scale() !== 1) return false;
        const effect = new Deformation(source, target, edge, direction === 'out' ? 0 : 1);
        const bounds = layered ? new DeformationBounds(effect) : null;
        const layer = layered ? new DeformationLayer() : null;
        const ownedEffects = [bounds, layer, effect].filter(Boolean);
        const timeline = new Clutter.Timeline({ duration: 500, actor });
        const timelineSignals = [];
        const actorSignals = [];
        let watchdog = 0;
        let work = false;
        let complete = false;
        const nativeSet = direction === 'out' ? Main.wm._minimizing : Main.wm._unminimizing;
        const finish = () => {
            if (complete) return;
            complete = true;
            for (const id of timelineSignals) timeline.disconnect(id);
            timelineSignals.length = 0;
            timeline.stop();
            try {
                timeline.set_actor(null);
            } catch {
                /* Older capability gate retains cleanup. */
            }
            if (watchdog) GLib.source_remove(watchdog);
            watchdog = 0;
            for (const [object, id] of actorSignals) {
                try {
                    object.disconnect(id);
                } catch {
                    /* Native actor may already be gone. */
                }
            }
            actorSignals.length = 0;
            for (const owned of [...ownedEffects].reverse()) {
                try {
                    actor.remove_effect(owned);
                } catch {
                    /* Destruction has already removed the owned effect. */
                }
                try {
                    owned.run_dispose();
                } catch {
                    /* Removing every owned effect remains mandatory. */
                }
            }
            ownedEffects.length = 0;
            this._active.delete(actor);
            if (layered) {
                try {
                    global.stage.queue_redraw();
                } catch {
                    /* A disappearing stage must not prevent native completion and work cleanup. */
                }
            }
            // GNOME's earlier kill handler may already have completed this transaction.
            try {
                if (work) {
                    work = false;
                    try {
                        if (this._metaUnredirect)
                            Meta.enable_unredirect_for_display(global.display);
                        else global.compositor.enable_unredirect();
                    } finally {
                        global.end_work();
                    }
                }
            } finally {
                if (nativeSet.has(actor)) params.onStopped(true);
            }
        };
        this._active.set(actor, { finish });
        if (this._metaUnredirect) Meta.disable_unredirect_for_display(global.display);
        else global.compositor.disable_unredirect();
        global.begin_work();
        work = true;
        actor.set_position(source.x, source.y);
        actor.set_scale(1, 1);
        actor.opacity = 255;
        if (bounds) actor.add_effect_with_name('diagnostic-hub-genie-bounds', bounds);
        if (layer) actor.add_effect_with_name('diagnostic-hub-genie-layer', layer);
        actor.add_effect_with_name(EFFECT_NAME, effect);
        if (layered) global.stage.queue_redraw();
        actorSignals.push([actor, actor.connect('destroy', finish)]);
        actorSignals.push([actor.meta_window, actor.meta_window.connect('size-changed', finish)]);
        actorSignals.push([
            actor.meta_window,
            actor.meta_window.connect('position-changed', finish),
        ]);
        timelineSignals.push(
            timeline.connect('new-frame', () => {
                if (
                    !this._enabled ||
                    Clutter.Actor.prototype.ease !== this._wrapper ||
                    effect.renderInvalid
                )
                    return finish();
                effect.progress =
                    direction === 'out' ? timeline.get_progress() : 1 - timeline.get_progress();
                effect.invalidate();
                if (layered) global.stage.queue_redraw();
            }),
        );
        timelineSignals.push(timeline.connect('completed', finish));
        watchdog = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
            watchdog = 0;
            finish();
            return GLib.SOURCE_REMOVE;
        });
        timeline.start();
        return true;
    }

    _finishAll() {
        for (const entry of [...this._active.values()]) entry.finish();
    }

    disable() {
        this._enabled = false;
        this._finishAll();
        for (const [object, id] of this._signals) object.disconnect(id);
        this._signals.length = 0;
        this._status?.unexport();
        this._status = null;
        if (Clutter.Actor.prototype.ease === this._wrapper)
            Clutter.Actor.prototype.ease = this._original;
        this._settings = null;
    }
}
