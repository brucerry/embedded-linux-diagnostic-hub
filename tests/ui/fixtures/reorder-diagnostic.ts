import type { JSHandle, Locator } from '@playwright/test';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

interface Collector {
    mark(): void;
    inspect(): unknown;
    finish(): unknown;
}
export interface ReorderObserver {
    handle: JSHandle<Collector> | null;
    status: 'active' | 'not-started' | 'install-failed' | 'collect-failed';
    markFailed: boolean;
}

/** Read only the installed SDK's two fixed files; never evaluate SDK modules. */
export function reorderSdkIdentity(): unknown {
    try {
        const file = createRequire(__filename).resolve('playwright-core/package.json');
        const core = join(dirname(file), 'lib/coreBundle.js');
        const sizes = [statSync(file), statSync(core)];
        if (
            !sizes.every((s) => s.isFile()) ||
            sizes[0].size > 64 * 1024 ||
            sizes[1].size > 64 * 1024 * 1024
        )
            return { status: 'unavailable' };
        const metadata = readFileSync(file),
            bytes = readFileSync(core);
        return {
            status: 'available',
            version: JSON.parse(metadata.toString('utf8')).version,
            packageSha256: createHash('sha256').update(metadata).digest('hex'),
            coreSha256: createHash('sha256').update(bytes).digest('hex'),
            coreBytes: bytes.length,
        };
    } catch {
        return { status: 'unavailable' };
    }
}

export async function startReorderDiagnostic(flow: Locator): Promise<ReorderObserver> {
    try {
        const handle = await flow.evaluateHandle((root) => {
            const events: unknown[] = [],
                snapshots: unknown[] = [];
            const counts: Record<string, number> = {};
            let overflow = false,
                observerErrors = 0,
                stopped = false;
            const origin = performance.now();
            const initial = Array.from(
                root.querySelectorAll<HTMLElement>('.automation-steps > li'),
            ).slice(0, 3);
            const source = initial[0]?.querySelector<HTMLElement>('.automation-drag-handle');
            const target = initial[2];
            const rect = (element?: Element | null) => {
                if (!element?.isConnected) return null;
                const b = element.getBoundingClientRect();
                return { x: b.x, y: b.y, width: b.width, height: b.height };
            };
            const describe = (element: Element | null) => ({
                tag: element?.tagName?.slice(0, 32),
                role: element?.getAttribute('role')?.slice(0, 32),
                row: element?.closest('[data-step-id]')?.getAttribute('data-step-id')?.slice(0, 64),
            });
            const snapshot = () => {
                const text = root.querySelector('.automation-reorder-notice')?.textContent;
                const notice = !text
                    ? 'empty'
                    : text === 'Reordering cancelled.'
                      ? 'cancelled'
                      : text === 'Step order updated.'
                        ? 'updated'
                        : /^Step moved to position (?:[1-9]|1\d|20)$/.test(text)
                          ? 'moved'
                          : 'other';
                return {
                    view: [scrollX, scrollY, innerWidth, innerHeight],
                    rows: Array.from(root.querySelectorAll<HTMLElement>('.automation-steps > li'))
                        .slice(0, 3)
                        .map((row) => ({
                            id: row.getAttribute('data-step-id')?.slice(0, 64),
                            draggable: row.draggable,
                            placeholder: row.classList.contains('automation-drag-placeholder'),
                            rect: rect(row),
                        })),
                    source: rect(source),
                    target: rect(target),
                    notice,
                    hidden: root.getClientRects().length === 0,
                    running: Boolean(root.querySelector('.automation-live-controls.is-running')),
                    dialogs: Math.min(
                        100,
                        document.querySelectorAll('[role="dialog"]:not([hidden])').length,
                    ),
                };
            };
            const error = () => {
                observerErrors = Math.min(1_000_000, observerErrors + 1);
            };
            const sample = (stage: string) => {
                try {
                    if (snapshots.length < 3) snapshots.push({ stage, state: snapshot() });
                } catch {
                    error();
                }
            };
            const owned: { type: string; callback: EventListener; capture: boolean }[] = [];
            const remove = () => {
                for (const item of owned)
                    document.removeEventListener(item.type, item.callback, item.capture);
                owned.length = 0;
            };
            try {
                for (const type of [
                    'pointerdown',
                    'mousedown',
                    'dragstart',
                    'dragenter',
                    'dragover',
                    'drop',
                    'dragend',
                    'scroll',
                ]) {
                    for (const capture of [true, false]) {
                        const phase = capture ? 'capture' : 'bubble';
                        const callback: EventListener = (event) => {
                            try {
                                const key = type + ':' + phase;
                                counts[key] = Math.min(1_000_000, (counts[key] ?? 0) + 1);
                                const mouse = event as MouseEvent,
                                    drag = event as DragEvent;
                                const element =
                                    event.target instanceof Element ? event.target : null;
                                const hit =
                                    Number.isFinite(mouse.clientX) && Number.isFinite(mouse.clientY)
                                        ? document.elementFromPoint(mouse.clientX, mouse.clientY)
                                        : null;
                                const record = {
                                    type,
                                    phase,
                                    ms: performance.now() - origin,
                                    trusted: event.isTrusted,
                                    prevented: event.defaultPrevented,
                                    button: mouse.button,
                                    buttons: mouse.buttons,
                                    x: mouse.clientX,
                                    y: mouse.clientY,
                                    target: describe(element),
                                    hit: describe(hit),
                                    transfer: {
                                        types: (drag.dataTransfer?.types ?? [])
                                            .slice(0, 8)
                                            .map((t) => t.slice(0, 64)),
                                        allowed: drag.dataTransfer?.effectAllowed,
                                        drop: drag.dataTransfer?.dropEffect,
                                    },
                                    state: snapshot(),
                                };
                                if (events.length === 64) {
                                    events.splice(8, 1);
                                    overflow = true;
                                }
                                events.push(record);
                            } catch {
                                error();
                            }
                        };
                        document.addEventListener(type, callback, { capture, passive: true });
                        owned.push({ type, callback, capture });
                    }
                }
                sample('before');
                return {
                    mark() {
                        if (!stopped) {
                            sample('after-gesture');
                            remove();
                        }
                    },
                    inspect() {
                        return { events, snapshots, counts, overflow, observerErrors };
                    },
                    finish() {
                        if (!stopped) {
                            try {
                                sample('final');
                            } finally {
                                stopped = true;
                                remove();
                            }
                        }
                        return { events, snapshots, counts, overflow, observerErrors };
                    },
                };
            } catch {
                remove();
                throw Error('Observer installation failed.');
            }
        });
        return { handle, status: 'active', markFailed: false };
    } catch {
        return { handle: null, status: 'install-failed', markFailed: false };
    }
}

export async function markReorderDiagnostic(observer: ReorderObserver): Promise<void> {
    try {
        await observer.handle?.evaluate((api) => api.mark());
    } catch {
        observer.markFailed = true;
    }
}

export async function readReorderDiagnostic(observer: ReorderObserver): Promise<unknown> {
    try {
        return await observer.handle?.evaluate((api) => api.inspect());
    } catch {
        observer.markFailed = true;
        return null;
    }
}
