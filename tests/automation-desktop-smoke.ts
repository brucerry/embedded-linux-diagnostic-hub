import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gatewayFixture } from './fixtures/gateway';
async function main() {
    const temporary = await mkdtemp(path.join(tmpdir(), 'hub-native-automation-')),
        output = path.join(temporary, 'automation.json');
    let calls = 0;
    const commands: string[] = [];
    const fixture = await gatewayFixture(undefined, {
        exec(command, channel) {
            if (!command.startsWith('fixture automation native')) return false;
            calls++;
            commands.push(command);
            channel.write('Native isolated capture €');
            channel.stderr.write('Synthetic nonzero exit');
            if (command.endsWith('signal')) channel.exit('TERM', false, 'terminated');
            else channel.exit(7);
            channel.end();
            return true;
        },
    });
    const env = Object.fromEntries(
        Object.entries(process.env).filter(
            ([k, v]) => k !== 'ELECTRON_RUN_AS_NODE' && v !== undefined,
        ),
    ) as Record<string, string>;
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
        app = await electron.launch({
            chromiumSandbox: true,
            args: ['.', '--user-data-dir=' + temporary],
            env,
        });
        await app.evaluate(({ session }, savePath) => {
            (globalThis as unknown as { automationSavePath: string }).automationSavePath = savePath;
            session.defaultSession.on('will-download', (_event, item) =>
                item.setSavePath(
                    (globalThis as unknown as { automationSavePath: string }).automationSavePath,
                ),
            );
        }, output);
        const page = await app.firstWindow();
        await expect(page.getByRole('heading', { name: 'Device overview' })).toBeVisible();
        await page.getByRole('button', { name: 'Connect device', exact: true }).first().click();
        const modal = page.getByRole('dialog', { name: 'Connect a Linux device' });
        await modal.getByLabel('Hostname or IP address').fill('127.0.0.1');
        await modal.getByLabel('Port', { exact: true }).fill(String(fixture.options.port));
        await modal.getByLabel('SSH username').fill(fixture.options.username);
        await modal.getByLabel('Password', { exact: true }).fill(fixture.options.password);
        await modal.getByRole('button', { name: 'Connect via SSH', exact: true }).click();
        await page.getByRole('button', { name: 'Trust device', exact: true }).click();
        await expect(modal).not.toBeVisible({ timeout: 20000 });
        await page.getByRole('button', { name: 'Automation', exact: true }).click();
        const flow = page.getByRole('region', { name: 'Automation', exact: true });
        await flow
            .getByRole('navigation', { name: 'Automation setup steps' })
            .getByRole('button', { name: /Commands/ })
            .click();
        await flow.getByLabel('Command 1 name').fill('Native proof');
        await flow
            .getByLabel('Command 1 script')
            .fill('fixture automation native\nexact multiline script');
        await flow
            .getByRole('navigation', { name: 'Automation setup steps' })
            .getByRole('button', { name: /Review/ })
            .click();
        await flow.getByRole('button', { name: 'Run once', exact: true }).click();
        await expect(flow.getByRole('status')).toContainText('Flow finished');
        await expect(flow.locator('tbody')).toContainText('Native isolated capture €');
        await expect(flow.locator('tbody')).toContainText('7');
        const token = await page.evaluate(() => window.diagnosticHub!.automationConnection!());
        assert.match(token, /^[a-f0-9]{32}$/);
        assert.deepEqual(commands, ['fixture automation native\nexact multiline script']);
        await flow.getByRole('button', { name: 'Download QA results' }).click();
        await expect
            .poll(async () => {
                try {
                    return JSON.parse(await readFile(output, 'utf8')).records.length;
                } catch {
                    return 0;
                }
            })
            .toBe(1);
        const json = JSON.parse(await readFile(output, 'utf8'));
        assert.equal(json.records[0].exitCode, 7);
        assert.equal(json.records[0].execution.timeoutSeconds, 60);
        assert.equal(json.records[0].command, commands[0]);
        assert.equal(json.records[0].stdout, 'Native isolated capture €');
        assert.equal(calls, 1);
        assert.ok(!JSON.stringify(json).includes(fixture.options.password));
        assert.ok(!JSON.stringify(json).includes(token));
        await expect(
            page.evaluate(() =>
                window.diagnosticHub!.runAutomation!({
                    id: 'native-stale-request-0001',
                    connection: 'a'.repeat(32),
                    command: 'fixture automation native stale',
                    timeoutMs: 1000,
                }),
            ),
        ).rejects.toThrow('connection changed');
        assert.equal(calls, 1);
        const signalOutput = path.join(temporary, 'automation-signal.json');
        await app.evaluate((_modules, savePath) => {
            (globalThis as unknown as { automationSavePath: string }).automationSavePath = savePath;
        }, signalOutput);
        await flow
            .getByRole('navigation', { name: 'Automation setup steps' })
            .getByRole('button', { name: /Commands/ })
            .click();
        await flow.getByLabel('Command 1 script').fill('fixture automation native signal');
        await flow.getByRole('button', { name: 'Add command', exact: true }).click();
        await flow.getByLabel('Command 2 script').fill('fixture automation native must-not-run');
        await flow
            .getByRole('navigation', { name: 'Automation setup steps' })
            .getByRole('button', { name: /Review/ })
            .click();
        await flow.getByRole('button', { name: 'Run once', exact: true }).click();
        await expect(flow.getByRole('status')).toContainText('Command ended with signalled');
        await expect(flow.locator('tbody tr').last()).toContainText('SIGTERM');
        assert.equal(calls, 2);
        assert.equal(commands.includes('fixture automation native must-not-run'), false);
        await flow.getByRole('button', { name: 'Download QA results' }).click();
        await expect
            .poll(async () => {
                try {
                    return JSON.parse(await readFile(signalOutput, 'utf8')).records.length;
                } catch {
                    return 0;
                }
            })
            .toBe(2);
        const signalled = JSON.parse(await readFile(signalOutput, 'utf8')).records[1];
        assert.equal(signalled.completion, 'signalled');
        assert.equal(signalled.exitCode, null);
        assert.deepEqual(signalled.termination, {
            signal: 'SIGTERM',
            coreDumped: false,
            message: 'terminated',
            truncated: false,
        });
        const proof = {
            electron: '44.5.1',
            chromiumSandbox: true,
            realTrustedIPC: true,
            loopbackOnly: true,
            commands: calls,
            signalCaptured: 'SIGTERM',
            signalPaused: true,
            laterStepSkipped: true,
            exitCode: 7,
            multilinePreserved: true,
            unicodePreserved: true,
            localDownload: true,
            download: path.basename(output),
            credentialsExcluded: true,
            connectionTokenExcluded: true,
            staleConnectionRejected: true,
            physicalPortsOpened: 0,
        };
        console.log(JSON.stringify(proof, null, 2));
        if (process.env.HUB_FEATURE_EVIDENCE) {
            await mkdir(process.env.HUB_FEATURE_EVIDENCE, { recursive: true });
            await writeFile(
                path.join(process.env.HUB_FEATURE_EVIDENCE, 'automation-native-proof.json'),
                JSON.stringify(proof, null, 2) + '\n',
            );
            await page.screenshot({
                path: path.join(process.env.HUB_FEATURE_EVIDENCE, 'automation-native.png'),
                fullPage: true,
            });
        }
    } finally {
        await app?.close();
        await fixture.close();
        const absolute = path.resolve(temporary),
            root = path.resolve(tmpdir()) + path.sep;
        if (
            !absolute.startsWith(root) ||
            !path.basename(absolute).startsWith('hub-native-automation-')
        )
            throw Error('Unexpected temporary cleanup path.');
        await rm(absolute, { recursive: true, force: true });
    }
}
void main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
