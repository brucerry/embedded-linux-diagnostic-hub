import {
    createLaunchTimingRecorder,
    type LaunchTimingRecorder,
    type LaunchTimingSnapshot,
} from '../shared/launch-timing';

declare global {
    interface Window {
        __hubLaunchTimingEnabled?: true;
        __hubLaunchTiming?: () => LaunchTimingSnapshot;
    }
}

let launchTiming: LaunchTimingRecorder | undefined;

// Called from main.tsx's first body statement, AFTER its static imports.
export function initializeRendererLaunchTiming() {
    if (window.__hubLaunchTimingEnabled !== true || launchTiming) return;
    // Paint entry startTime and performance.now() share this document's origin.
    launchTiming = createLaunchTimingRecorder('renderer-navigation', () => performance.now(), 0);
    launchTiming.mark('renderer-entry-body');
    window.__hubLaunchTiming = () => {
        // Read buffered browser evidence only on explicit snapshot request.
        // No observer, recurring task, timer or extra animation frame is installed.
        const paint = performance.getEntriesByName('first-contentful-paint', 'paint')[0];
        if (paint) launchTiming!.mark('renderer-first-contentful-paint', paint.startTime);
        return launchTiming!.snapshot();
    };
}

export function markRendererAppLayoutEffect() {
    launchTiming?.mark('renderer-app-layout-effect');
}
