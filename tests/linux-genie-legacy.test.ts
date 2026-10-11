import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { unzipSync, zipSync } from 'fflate';
import {
    createGeniePackage,
    validateGeniePackage,
    genieAsset,
} from '../scripts/lib/genie-package.mjs';
import { deform } from '../linux/gnome-genie/geometry.js';

const version = '1.2.3-test.1';
const commit = 'a'.repeat(40);

test('legacy modules share the owned effect and math but cannot be accepted as modern ZIPs', async () => {
    const modern = await createGeniePackage(process.cwd(), version, commit);
    const legacy = await createGeniePackage(process.cwd(), version, commit, 'legacy42');
    assert.notEqual(genieAsset(version), genieAsset(version, 'legacy42'));
    assert.deepEqual(
        validateGeniePackage(legacy.zip, version, commit, legacy.files, 'legacy42'),
        legacy.build,
    );
    assert.throws(() => validateGeniePackage(legacy.zip, version, commit), /identity/);
    assert.throws(
        () => validateGeniePackage(modern.zip, version, commit, undefined, 'legacy42'),
        /identity/,
    );
    const files = unzipSync(legacy.zip);
    for (const name of ['extension.js', 'geometry.js', 'build-info.js']) {
        const source = Buffer.from(files[name]).toString();
        assert.doesNotMatch(source, /^\s*(?:import|export)\s/m);
        new vm.Script(source); // Parse as a legacy script, not an ESM module.
    }
    const geometry = vm.createContext({});
    new vm.Script(Buffer.from(files['geometry.js']).toString()).runInContext(geometry);
    const source = { x: -1200, y: -200, width: 1000, height: 700 };
    const target = { x: -1600, y: 100, width: 40, height: 40 };
    for (const edge of ['top', 'bottom', 'left', 'right'])
        for (const p of [0, 0.25, 0.65, 1])
            assert.deepEqual(
                JSON.parse(JSON.stringify(geometry.deform(source, target, edge, p, 0.3, 0.7))),
                deform(source, target, edge, p, 0.3, 0.7),
            );
    const metadata = JSON.parse(Buffer.from(files['metadata.json']).toString());
    metadata['shell-version'] = ['46', '48', '50'];
    assert.throws(
        () =>
            validateGeniePackage(
                zipSync({ ...files, 'metadata.json': Buffer.from(JSON.stringify(metadata)) }),
                version,
                commit,
                undefined,
                'legacy42',
            ),
        /identity/,
    );
    assert.throws(
        () => validateGeniePackage(legacy.zip, version, commit, modern.files, 'legacy42'),
        /parity/,
    );
});

// These API fixtures exercise generated legacy code. They do not qualify GNOME rendering.
test('legacy lifecycle preserves native completion, watchdog cleanup and read-only status', async () => {
    const { files, build } = await createGeniePackage(process.cwd(), version, commit, 'legacy42');
    class Signals {
        signals = new Map<number, { name: string; callback: (...args: any[]) => void }>();
        next = 1;
        connect(name: string, callback: (...args: any[]) => void) {
            const id = this.next++;
            this.signals.set(id, { name, callback });
            return id;
        }
        connect_after(name: string, callback: (...args: any[]) => void) {
            return this.connect(name, callback);
        }
        disconnect(id: number) {
            this.signals.delete(id);
        }
    }
    let fallback = 0;
    const _easeActor = (_actor: unknown, _params: unknown) => {
        fallback++;
    };
    class Actor extends Signals {
        ease(params: unknown) {
            _easeActor(this, params);
        }
        effects: any[] = [];
        mapped = true;
        opacity = 255;
        windowApp = 'diagnostic-hub.desktop';
        meta_window = Object.assign(new Signals(), {
            get_wm_class: () => 'diagnostic-hub',
            get_buffer_rect: () => ({ x: 100, y: 50, width: 800, height: 600 }),
            get_icon_geometry: () => [true, { x: 700, y: 950, width: 40, height: 40 }],
        });
        get_effects() {
            return this.effects;
        }
        add_effect_with_name(_name: string, effect: unknown) {
            this.effects.push(effect);
        }
        remove_effect(effect: unknown) {
            this.effects = this.effects.filter((item) => item !== effect);
        }
        set_position() {}
        set_scale() {}
    }
    class Effect {
        constructor(...args: unknown[]) {
            (this as any)._init(...args);
        }
        _init() {}
        set_n_tiles() {}
        run_dispose() {}
        invalidate() {}
    }
    const timelines: Timeline[] = [];
    class Timeline extends Signals {
        actor: unknown;
        stopped = false;
        constructor(props: { actor: unknown }) {
            super();
            this.actor = props.actor;
            timelines.push(this);
        }
        start() {}
        stop() {
            this.stopped = true;
        }
        set_actor(actor: unknown) {
            this.actor = actor;
        }
        get_progress() {
            return 0.5;
        }
    }
    let animations = true,
        work = 0,
        unredirect = 0;
    const timers = new Map<number, () => void>();
    const status: { methods?: { GetStatus: () => string }; exported: boolean } = {
        exported: false,
    };
    const wm = { _minimizing: new Set<Actor>(), _unminimizing: new Set<Actor>() };
    const geometry = vm.createContext({});
    new vm.Script(Buffer.from(files['geometry.js']).toString()).runInContext(geometry);
    const identity = vm.createContext({});
    new vm.Script(Buffer.from(files['build-info.js']).toString()).runInContext(identity);
    const metadata = Buffer.from(files['metadata.json']);
    const context = vm.createContext({
        console,
        Set,
        Map,
        imports: {
            gi: {
                Clutter: { Actor, DeformEffect: Effect, Timeline },
                GObject: { registerClass: (klass: unknown) => klass },
                Meta: {
                    disable_unredirect_for_display: () => {
                        unredirect++;
                    },
                    enable_unredirect_for_display: () => {
                        unredirect--;
                    },
                },
                GLib: {
                    PRIORITY_DEFAULT: 0,
                    SOURCE_REMOVE: false,
                    timeout_add: (_priority: number, delay: number, callback: () => void) => {
                        assert.equal(delay, 2000);
                        const id = timers.size + 1;
                        timers.set(id, callback);
                        return id;
                    },
                    source_remove: (id: number) => timers.delete(id),
                },
                Shell: {
                    WindowTracker: {
                        get_default: () => ({
                            get_window_app: (window: unknown) => ({
                                get_id: () =>
                                    window === actor.meta_window ? actor.windowApp : null,
                            }),
                        }),
                    },
                },
                Gio: {
                    Settings: class extends Signals {
                        get_boolean() {
                            return animations;
                        }
                    },
                    File: { new_for_path: () => ({ load_contents: () => [true, metadata] }) },
                    DBus: { session: {} },
                    DBusExportedObject: {
                        wrapJSObject: (_xml: string, methods: { GetStatus: () => string }) => {
                            status.methods = methods;
                            return {
                                export: () => {
                                    status.exported = true;
                                },
                                unexport: () => {
                                    status.exported = false;
                                },
                            };
                        },
                    },
                },
            },
            ui: {
                main: {
                    wm,
                    overview: {},
                    layoutManager: Object.assign(new Signals(), {
                        monitors: [{ x: 0, y: 0, width: 1600, height: 1000 }],
                    }),
                },
            },
            misc: {
                config: { PACKAGE_VERSION: '42.9' },
                extensionUtils: {
                    getCurrentExtension: () => ({
                        path: '/fixture',
                        imports: { geometry, 'build-info': identity },
                    }),
                },
            },
            byteArray: { toString: (bytes: Uint8Array) => Buffer.from(bytes).toString() },
        },
        global: {
            window_manager: new Signals(),
            display: {},
            begin_work: () => {
                work++;
            },
            end_work: () => {
                work--;
            },
        },
    });
    const actor = new Actor();
    new vm.Script(Buffer.from(files['extension.js']).toString()).runInContext(context);
    const originalEase = Actor.prototype.ease;
    const extension = context.init();
    // Each missing capability must leave the native route untouched and status inactive.
    const api = context.imports.gi;
    const missing = [
        [wm, '_minimizing'],
        [wm, '_unminimizing'],
        [api.Clutter.Timeline.prototype, 'start'],
        [context.global, 'begin_work'],
        [context.global, 'end_work'],
        [api.Meta, 'disable_unredirect_for_display'],
        [api.Meta, 'enable_unredirect_for_display'],
    ] as const;
    for (const [owner, key] of missing) {
        const saved = (owner as any)[key];
        delete (owner as any)[key];
        try {
            extension.enable();
            assert.equal(Actor.prototype.ease, originalEase, key);
            assert.equal(JSON.parse(status.methods!.GetStatus()).active, false, key);
            assert.deepEqual(JSON.parse(status.methods!.GetStatus()).capabilities, []);
            extension.disable();
            assert.equal(status.exported, false);
            assert.equal(work, 0);
            assert.equal(timers.size, 0);
        } finally {
            (owner as any)[key] = saved;
        }
    }
    // A complete compositor pair remains usable if Meta exposes only acquisition.
    const enableUnredirect = api.Meta.enable_unredirect_for_display;
    delete api.Meta.enable_unredirect_for_display;
    context.global.compositor = {
        disable_unredirect: () => {
            unredirect++;
        },
        enable_unredirect: () => {
            unredirect--;
        },
    };
    extension.enable();
    wm._minimizing.add(actor);
    actor.ease({ onStopped: () => wm._minimizing.delete(actor) });
    assert.equal(extension._active.size, 1);
    extension._finishAll();
    assert.equal(work, 0);
    assert.equal(unredirect, 0);
    extension.disable();
    delete context.global.compositor;
    api.Meta.enable_unredirect_for_display = enableUnredirect;
    extension.enable();
    assert.ok(status.exported);
    assert.deepEqual(Object.keys(status.methods!), ['GetStatus']);
    assert.equal(JSON.parse(status.methods!.GetStatus()).format, build.format);
    assert.equal(JSON.parse(status.methods!.GetStatus()).active, true);
    let completions = 0;
    const params = {
        onStopped: () => {
            completions++;
            wm._minimizing.delete(actor);
            wm._unminimizing.delete(actor);
        },
    };
    actor.windowApp = 'unrelated.desktop';
    wm._minimizing.add(actor);
    actor.ease(params);
    assert.equal(fallback, 1);
    actor.windowApp = 'diagnostic-hub.desktop';
    animations = false;
    actor.ease(params);
    assert.equal(fallback, 2);
    animations = true;
    const iconGeometry = actor.meta_window.get_icon_geometry;
    const savedError = context.console;
    context.console = { error() {} }; // Expected per-window fallback, not a noisy test failure.
    delete (actor.meta_window as any).get_icon_geometry;
    actor.ease(params);
    assert.equal(fallback, 3);
    assert.equal(extension._active.size, 0);
    assert.equal(actor.effects.length, 0);
    assert.equal(work, 0);
    assert.equal(timers.size, 0);
    actor.meta_window.get_icon_geometry = iconGeometry;
    context.console = savedError;
    actor.ease(params);
    assert.equal(actor.effects.length, 1);
    assert.equal(work, 1);
    extension._active.get(actor).finish();
    extension._finishAll();
    assert.equal(completions, 1);
    assert.equal(actor.effects.length, 0);
    wm._unminimizing.add(actor);
    actor.ease(params);
    const [watchdog] = timers.values();
    timers.clear();
    watchdog();
    assert.equal(completions, 2);
    wm._unminimizing.add(actor);
    actor.ease(params);
    extension.disable();
    assert.equal(completions, 3);
    assert.equal(work, 0);
    assert.equal(unredirect, 0);
    assert.equal(timers.size, 0);
    assert.equal(actor.effects.length, 0);
    assert.ok(
        timelines.every((item) => item.stopped && item.actor === null && item.signals.size === 0),
    );
    assert.equal(status.exported, false);
    assert.equal(Actor.prototype.ease, originalEase);
});

test('Python installer validates format identity and temporary update/removal contracts', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'hub-genie-format-'));
    try {
        for (const format of ['modern', 'legacy42']) {
            const { zip } = await createGeniePackage(process.cwd(), version, commit, format);
            await writeFile(path.join(directory, format + '.zip'), zip);
        }
        const executable =
            process.env.HUB_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
        const result = spawnSync(
            executable,
            [
                '-B',
                'tests/fixtures/genie-format-contract.py',
                path.resolve('linux/gnome-genie/setup.py'),
                directory,
            ],
            { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
        );
        assert.equal(result.status, 0, result.stdout + result.stderr);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
