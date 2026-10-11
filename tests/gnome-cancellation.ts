import assert from 'node:assert/strict';
import { _electron, expect } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function main() {
    assert.equal(process.env.HUB_GNOME_ISOLATED, '1');
    assert.equal(process.env.HUB_GNOME_CANCEL_ONLY, '1');
    const output = process.env.HUB_GNOME_EVIDENCE!;
    await mkdir(output, { recursive: true });
    const env = Object.fromEntries(
        Object.entries(process.env).filter(
            ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
        ),
    ) as Record<string, string>;
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
    const observations: unknown[] = [];
    for (let repetition = 0; repetition < 5; repetition++) {
        const profile = await mkdtemp(path.join(tmpdir(), 'hub-cancel-'));
        const desktop = await _electron.launch({
            executablePath: process.env.HUB_TEST_EXECUTABLE!,
            chromiumSandbox: true,
            env,
            args: [
                `--ozone-platform=${process.env.HUB_GNOME_BACKEND}`,
                `--user-data-dir=${profile}`,
            ],
            timeout: 40000,
        });
        let control: ReturnType<typeof spawn> | undefined;
        const file = path.join(output, `cancel-${repetition}.json`);
        try {
            const page = await desktop.firstWindow();
            await expect(page.getByRole('heading', { name: 'Device overview' })).toBeVisible();
            const title = await desktop.evaluate(({ BrowserWindow }) =>
                BrowserWindow.getAllWindows()[0].getTitle(),
            );
            control = spawn('gjs', ['-m', 'tests/fixtures/gnome-control.js', title], {
                env,
                stdio: 'ignore',
            });
            await expect
                .poll(
                    () =>
                        evaluate(
                            "global.get_window_actors().some(a=>a.meta_window.get_gtk_application_id() === 'dev.diagnostichub.Control')",
                        ),
                    { timeout: 15000 },
                )
                .toMatch(/^\(true, ['"]true/);
            const fixture = (await readFile('tests/fixtures/gnome-native.js', 'utf8'))
                .replace("'__REPORT_PATH__'", JSON.stringify(file))
                .replace("'__STRESS_ENABLED__'", "'1'");
            assert.match(evaluate('void ' + fixture), /^\(true,/);
            // Cancel while rapid native resize/reversal activity is active, before teardown.
            await expect
                .poll(() => evaluate('global.hubQualificationStressActive === true'), {
                    timeout: 8000,
                })
                .toMatch(/^\(true, ['"]true/);
            await page.waitForTimeout(40 + repetition * 20);
            assert.match(evaluate('void global.hubQualificationCancel()'), /^\(true,/);
            await expect
                .poll(
                    async () => {
                        try {
                            return JSON.parse(await readFile(file, 'utf8'));
                        } catch {
                            return null;
                        }
                    },
                    { timeout: 6000 },
                )
                .toMatchObject({ ok: false });
            const native = JSON.parse(await readFile(file, 'utf8'));
            assert.match(native.error, /qualification cancelled before actor teardown/);
            await expect
                .poll(
                    () =>
                        evaluate(
                            "Main.extensionManager.lookup('diagnostic-hub-genie@diagnostichub.desktop').stateObj._active.size === 0",
                        ),
                    { timeout: 3000 },
                )
                .toMatch(/^\(true, ['"]true/);
            assert.ok(
                native.stress.resizeRequests >= 1,
                'Cancellation must cross actual resize activity',
            );
            observations.push({
                repetition,
                cancelled: true,
                stressCycles: native.stress.cycles,
                resizeRequests: native.stress.resizeRequests,
            });
        } finally {
            control?.kill('SIGTERM');
            await desktop.close();
            await rm(profile, { recursive: true, force: true });
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.match(
            evaluate(
                "global.get_window_actors().filter(a=>a.meta_window.get_wm_class()?.toLowerCase()==='diagnostic-hub').length === 0",
            ),
            /^\(true, ['"]true/,
        );
        assert.match(evaluate('1+1'), /^\(true, ['"]2/);
    }
    await writeFile(
        path.join(output, 'cancellation.json'),
        JSON.stringify(
            {
                ok: true,
                backend: process.env.HUB_GNOME_BACKEND,
                repetitions: 5,
                observations,
                scope: 'owned asynchronous fixture cancellation before actual target window teardown',
            },
            null,
            4,
        ),
    );
}
main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
});
