import assert from 'node:assert/strict';
import { _electron, expect } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

async function main() {
    assert.equal(process.env.HUB_GNOME_ISOLATED, '1');
    assert.equal(process.env.HUB_GNOME_CAPTURE_ONLY, '1');
    const output = process.env.HUB_GNOME_EVIDENCE!;
    await mkdir(output, { recursive: true });
    const root = await mkdtemp(path.join(tmpdir(), 'hub-render-probe-'));
    const env = Object.fromEntries(
        Object.entries(process.env).filter(
            ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
        ),
    ) as Record<string, string>;
    const desktop = await _electron.launch({
        executablePath: process.env.HUB_TEST_EXECUTABLE!,
        chromiumSandbox: true,
        env,
        args: ['--ozone-platform=wayland', `--user-data-dir=${root}`],
        timeout: 40000,
    });
    const evaluate = (source: string) =>
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
                JSON.stringify(source),
            ],
            { encoding: 'utf8', timeout: 5000 },
        );
    let control: ReturnType<typeof spawn> | undefined;
    const report: Record<string, unknown> = {
        ok: false,
        scope: 'GNOME50 supported GL/media visual probe; no board connection',
    };
    try {
        const page = await desktop.firstWindow();
        await expect(page.getByRole('heading', { name: 'Device overview' })).toBeVisible();
        const title = await desktop.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].getTitle(),
        );
        evaluate(
            "global.get_window_actors().find(a=>a.meta_window.get_wm_class()?.toLowerCase()==='diagnostic-hub').meta_window.activate(global.get_current_time())",
        );
        await page.waitForTimeout(600);
        execFileSync('xwd', ['-root', '-silent', '-out', path.join(output, 'baseline.xwd')]);
        await page.screenshot({ path: path.join(output, 'renderer-only.png') });
        report.baselineActor =
            evaluate(`global.get_window_actors().filter(a=>a.meta_window.get_wm_class()?.toLowerCase()==='diagnostic-hub').map(a=>({
            position:a.get_transformed_position(),size:a.get_transformed_size(),visible:a.visible,mapped:a.mapped,opacity:a.get_paint_opacity(),
            monitor:a.meta_window.get_monitor(),buffer:a.meta_window.get_buffer_rect(),children:a.get_children().map(c=>({type:c.constructor.name,visible:c.visible,mapped:c.mapped,width:c.width,height:c.height}))
        }))`);
        control = spawn('gjs', ['-m', 'tests/fixtures/gnome-control.js', title], {
            env,
            stdio: 'ignore',
        });
        await page.waitForTimeout(1000);
        const file = path.join(output, 'native-render.json');
        let source = (
            await readFile(
                process.env.HUB_GNOME_DOCK_VISUAL === '1'
                    ? 'tests/fixtures/gnome-dock-visual.js'
                    : 'tests/fixtures/gnome-native.js',
                'utf8',
            )
        )
            .replaceAll("'__REPORT_PATH__'", JSON.stringify(file))
            .replaceAll(
                "'__TOP_ONLY__'",
                JSON.stringify(process.env.HUB_GNOME_TOP_ONLY === '1' ? '1' : '0'),
            )
            .replace("'__STRESS_ENABLED__'", "'0'")
            .replace("'__KEEP_PRIVATE_LAYER__'", "'0'")
            .replace("'__TEXTURE_EXPORT__'", "'1'")
            .replace(
                "'__VOLUME_CONTROL__'",
                JSON.stringify(process.env.HUB_GNOME_VOLUME_CONTROL === '1' ? '1' : '0'),
            )
            .replace(
                "'__PRIVATE_LAYER__'",
                JSON.stringify(process.env.HUB_GNOME_PRIVATE_LAYER === '1' ? '1' : '0'),
            );
        if (process.env.HUB_GNOME_VOLUME_CONTROL === '1') {
            const setup = await readFile('tests/fixtures/gnome-volume-layer.js', 'utf8');
            source = '(async()=>{ await ' + setup + ' await ' + source + ' })();';
        }
        if (process.env.HUB_GNOME_SHORT_PROBE === '1') {
            source = source.replaceAll('cycle < 100', 'cycle < 3');
            report.scope = 'three-cycle target-surface diagnostic, not full matrix qualification';
        }
        const reply = execFileSync(
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
                JSON.stringify('void ' + source),
            ],
            { encoding: 'utf8', timeout: 5000 },
        );
        assert.match(reply, /^\(true,/);
        let native: any;
        for (let i = 0; i < 400; i++) {
            try {
                native = JSON.parse(await readFile(file, 'utf8'));
                break;
            } catch {
                await page.waitForTimeout(500);
            }
        }
        assert.ok(native, 'bounded native render probe timed out');
        report.native = native;
        assert.equal(native.ok, true, native.error);
        const hashes: string[] = [];
        const colors: number[] = [];
        for (let i = 0; i < native.frames.length; i++) {
            const frame = await readFile(`${file}.${i}.xwd`);
            const pixels = frame.subarray(frame.readUInt32BE(0) + frame.readUInt32BE(76) * 12);
            colors.push(new Set(pixels).size);
            hashes.push(createHash('sha256').update(pixels).digest('hex'));
        }
        report.pixelValueCounts = colors;
        report.distinctFrames = new Set(hashes).size;
        assert.ok(
            colors.every((n) => n >= 16),
            'external output is blank; visual gate fails',
        );
        assert.ok(new Set(hashes).size >= 2, 'external output did not change');
        report.pixelGatePassed = true;
        report.visualReview =
            'required: changing desktop pixels alone do not prove target deformation';
    } catch (error) {
        report.error = String(error);
        throw error;
    } finally {
        await writeFile(path.join(output, 'render-probe.json'), JSON.stringify(report, null, 4));
        control?.kill('SIGTERM');
        await desktop.close();
        if (process.env.HUB_GNOME_PRESERVE_PROFILE !== '1')
            await rm(root, { recursive: true, force: true });
        else await writeFile(path.join(output, 'profile-path.txt'), root + '\n');
    }
}
main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
});
