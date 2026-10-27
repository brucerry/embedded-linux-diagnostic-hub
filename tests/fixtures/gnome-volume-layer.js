// Isolated supported-API experiment. Never loaded by the production companion.
(async () => {
    const { default: Clutter } = await import('gi://Clutter');
    const { default: GObject } = await import('gi://GObject');
    const { default: Graphene } = await import('gi://Graphene');
    const Main = await import('resource:///org/gnome/shell/ui/main.js');
    const ext = Main.extensionManager.lookup('diagnostic-hub-genie@diagnostichub.desktop').stateObj;
    const { deform } = await import(`file://${ext.path}/geometry.js`);
    const Wrapper = GObject.registerClass(
        class HubVolumePrivateLayer extends Clutter.OffscreenEffect {
            vfunc_pre_paint(node, context) {
                const volume = this.get_actor().get_paint_volume();
                const origin = volume?.get_origin();
                this.beforePaint = volume
                    ? {
                          origin: { x: origin.x, y: origin.y, z: origin.z },
                          width: volume.get_width(),
                          height: volume.get_height(),
                      }
                    : null;
                return super.vfunc_pre_paint(node, context);
            }
        },
    );
    const Bounds = GObject.registerClass(
        class HubVolumeBounds extends Clutter.Effect {
            _init(effect) {
                super._init();
                this.effect = effect;
            }
            vfunc_modify_paint_volume(volume) {
                const actor = this.get_actor(),
                    s = this.effect.source,
                    t = this.effect.target,
                    o = volume.get_origin();
                const x = Math.floor(Math.min(o.x, t.x - s.x - 2)),
                    y = Math.floor(Math.min(o.y, t.y - s.y - 2));
                const right = Math.ceil(
                    Math.max(o.x + volume.get_width(), t.x + t.width - s.x + 2),
                );
                const bottom = Math.ceil(
                    Math.max(o.y + volume.get_height(), t.y + t.height - s.y + 2),
                );
                volume.set_origin(new Graphene.Point3D({ x, y, z: o.z }));
                volume.set_width(right - x);
                volume.set_height(bottom - y);
                // Mutter pads an integer paint box by3; its local FBO origin is2px earlier.
                this.effect.canvas = {
                    x: x - 2,
                    y: y - 2,
                    width: right - x + 3,
                    height: bottom - y + 3,
                };
                return true;
            }
        },
    );
    const Mesh = GObject.registerClass(
        class HubVolumeDeformation extends Clutter.DeformEffect {
            _init(original) {
                super._init();
                this.source = original.source;
                this.target = original.target;
                this.edge = original.edge;
                this.set_n_tiles(24, 32);
                Object.defineProperty(this, 'progress', {
                    get: () => original.progress,
                    set: () => {},
                    configurable: true,
                });
            }
            vfunc_deform_vertex(width, height, v) {
                const c = this.canvas;
                if (!c) return;
                const tx = Math.max(0, Math.min(1, (c.x + v.tx * width) / this.source.width));
                const ty = Math.max(0, Math.min(1, (c.y + v.ty * height) / this.source.height));
                const p = deform(this.source, this.target, this.edge, this.progress, tx, ty);
                v.x = p.x - c.x;
                v.y = p.y - c.y;
            }
        },
    );
    global.hubQualificationVolumeAdapter = (actor, stats) => {
        if (actor.get_resource_scale() !== 1)
            throw Error('Volume diagnostic currently requires measured resource scale1');
        const addEffect = actor.add_effect_with_name,
            removeEffect = actor.remove_effect;
        const ownedLayers = new Map();
        stats.volumeControl = true;
        actor.add_effect_with_name = function (name, original) {
            if (name !== 'diagnostic-hub-genie') return addEffect.call(this, name, original);
            const mesh = new Mesh(original),
                bounds = new Bounds(mesh),
                layer = new Wrapper();
            const invalidate = original.invalidate;
            original.invalidate = () => mesh.invalidate();
            addEffect.call(this, 'hub-private-volume', bounds);
            addEffect.call(this, 'hub-native-private-layer', layer);
            const value = addEffect.call(this, name, mesh);
            ownedLayers.set(original, { mesh, bounds, layer, invalidate });
            stats.added++;
            return value;
        };
        actor.remove_effect = function (original) {
            const entry = ownedLayers.get(original);
            if (!entry) return removeEffect.call(this, original);
            original.invalidate = entry.invalidate;
            removeEffect.call(this, entry.mesh);
            removeEffect.call(this, entry.layer);
            removeEffect.call(this, entry.bounds);
            entry.mesh.run_dispose();
            entry.layer.run_dispose();
            entry.bounds.run_dispose();
            ownedLayers.delete(original);
            stats.removed++;
        };
        return {
            addEffect,
            removeEffect,
            ownedLayers,
            restore: () => {
                for (const original of [...ownedLayers.keys()]) actor.remove_effect(original);
                actor.add_effect_with_name = addEffect;
                actor.remove_effect = removeEffect;
            },
        };
    };
})();
