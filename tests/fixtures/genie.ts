import type { ElectronApplication } from '@playwright/test';
import { TaskbarReader } from '../../electron/taskbar-reader';

/** Scope normal-motion qualification to the test process; never change Windows preferences. */
export async function configureGenieTest(desktop: ElectronApplication) {
    const forceNormal = process.env.HUB_TEST_GENIE_MOTION === '1';
    const capabilities = await desktop.evaluate(
        ({ app, systemPreferences, nativeTheme, screen }, forceNormal) => {
            if (process.platform !== 'win32') return { platform: process.platform };
            const original = systemPreferences.getAnimationSettings.bind(systemPreferences);
            const motion = original();
            const ffi = process
                .getBuiltinModule('module')
                .createRequire(app.getAppPath() + '/package.json')('koffi');
            const enabled = [0];
            const status = ffi
                .load(
                    process
                        .getBuiltinModule('path')
                        .join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/dwmapi.dll'),
                )
                .func('int32_t __stdcall DwmIsCompositionEnabled(_Out_ int32_t *)')(enabled);
            if (forceNormal) {
                systemPreferences.getAnimationSettings = () => ({
                    ...original(),
                    prefersReducedMotion: false,
                });
                nativeTheme.emit('updated');
            }
            return {
                platform: process.platform,
                motion,
                forceNormal,
                compositor: { status, enabled: enabled[0] === 1 },
                displays: screen.getAllDisplays().map(({ bounds, workArea, scaleFactor }) => ({
                    bounds,
                    workArea,
                    scaleFactor,
                })),
            };
        },
        forceNormal,
    );
    console.log('Native Genie test capabilities: ' + JSON.stringify(capabilities));
}

export async function diagnoseGenieTaskbar() {
    const reader = new TaskbarReader('dev.diagnostichub.desktop', () => 'Diagnostic Hub');
    try {
        console.error('Native Genie shell geometry: ' + JSON.stringify(await reader.prime()));
    } finally {
        reader.close();
    }
}
