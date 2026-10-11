import assert from 'node:assert/strict';
import { _electron, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
async function main() {
    assert.equal(process.env.HUB_GNOME_ISOLATED, '1');
    assert.equal(process.env.HUB_GNOME_MESH_ONLY, '1');
    const output = process.env.HUB_GNOME_EVIDENCE!;
    await mkdir(output, { recursive: true });
    const profile = await mkdtemp(path.join(tmpdir(), 'hub-bounds-'));
    const env = Object.fromEntries(
        Object.entries(process.env).filter(
            ([k, v]) => k !== 'ELECTRON_RUN_AS_NODE' && v !== undefined,
        ),
    ) as Record<string, string>;
    const desktop = await _electron.launch({
        executablePath: process.env.HUB_TEST_EXECUTABLE!,
        chromiumSandbox: true,
        env,
        args: ['--ozone-platform=wayland', `--user-data-dir=${profile}`],
        timeout: 40000,
    });
    const evaluate = (s: string) =>
        execFileSync(
            'gdbus',
            [
                'call',
                '--session',
                '--dest',
                'org.gnome.Shell',
                '--object-path',
                '/org/gnome/Shell',
                '--method',
                'org.gnome.Shell.Eval',
                JSON.stringify(s),
            ],
            { encoding: 'utf8', timeout: 5000 },
        );
    const file = path.join(output, 'mesh.json');
    try {
        const page = await desktop.firstWindow();
        await expect(page.getByRole('heading', { name: 'Device overview' })).toBeVisible();
        await writeFile(
            path.join(output, 'electron-bounds.json'),
            JSON.stringify(
                await desktop.evaluate(({ BrowserWindow }) => {
                    const w = BrowserWindow.getAllWindows()[0];
                    return {
                        bounds: w.getBounds(),
                        normal: w.getNormalBounds(),
                        minimum: w.getMinimumSize(),
                        content: w.getContentBounds(),
                    };
                }),
                null,
                4,
            ),
        );
        const source = (
            await readFile(
                process.env.HUB_GNOME_APP_LAYER_ONLY === '1'
                    ? 'tests/fixtures/gnome-app-layer.js'
                    : process.env.HUB_GNOME_STAGE_ONLY === '1'
                      ? 'tests/fixtures/gnome-stage.js'
                      : process.env.HUB_GNOME_PRIMITIVE_ONLY === '1'
                        ? 'tests/fixtures/gnome-primitive.js'
                        : 'tests/fixtures/gnome-mesh.js',
                'utf8',
            )
        ).replaceAll('__OUTPUT__', output);
        assert.match(evaluate(source), /^\(true,/);
        await expect
            .poll(
                async () => {
                    try {
                        return JSON.parse(await readFile(file, 'utf8'));
                    } catch {
                        return null;
                    }
                },
                { timeout: 90000 },
            )
            .not.toBeNull();
        const report = JSON.parse(await readFile(file, 'utf8'));
        console.log(JSON.stringify(report));
        assert.equal(report.ok, true, report.error || 'mesh diagnostic failed');
    } finally {
        await desktop.close();
        await rm(profile, { recursive: true, force: true });
    }
}
main().catch((e) => {
    console.error(String(e));
    process.exitCode = 1;
});
