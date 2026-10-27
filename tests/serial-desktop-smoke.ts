import assert from 'node:assert/strict';
import { _electron as electron } from '@playwright/test';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
async function main() {
    const temporary = await mkdtemp(path.join(tmpdir(), 'hub-serial-api-'));
    const harness = path.join(temporary, 'main.cjs'),
        helper = path.join(temporary, 'serial.cjs');
    await build({
        entryPoints: ['electron/serial.ts'],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: helper,
        external: ['electron'],
    });
    await writeFile(
        harness,
        [
            "const {app,BrowserWindow,protocol,session}=require('electron');",
            "protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);",
            'app.whenReady().then(async()=>{',
            "protocol.handle('app',()=>new Response('<!doctype html><title>Serial API gate</title>',{headers:{'Content-Type':'text/html'}}));",
            'const original=session.defaultSession.setPermissionCheckHandler.bind(session.defaultSession);',
            'session.defaultSession.setPermissionCheckHandler=(handler)=>{global.checkSerial=handler;global.serialPolicyChecks=[];original((owner,permission,origin,details)=>{const allowed=handler(owner,permission,origin,details);global.serialPolicyChecks.push({permission,origin,details,allowed});return global.forceSerialProbeDenied?false:allowed;});};',
            'const w=new BrowserWindow({show:true,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});',
            'global.serialWindow=w;global.serialEvents=[];',
            'const send=w.webContents.send.bind(w.webContents);w.webContents.send=(channel,...args)=>{global.serialEvents.push({channel,args});send(channel,...args);};',
            'global.control=require(' +
                JSON.stringify(helper) +
                ").configureSerial(w,'app://bundle/index.html',()=>false);",
            "await w.loadURL('app://bundle/index.html');",
            '});',
            "app.on('window-all-closed',()=>app.quit());",
        ].join('\n'),
    );
    const env = Object.fromEntries(
        Object.entries(process.env).filter(
            ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
        ),
    ) as Record<string, string>;
    let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
        desktop = await electron.launch({
            chromiumSandbox: true,
            args: [harness, '--user-data-dir=' + temporary],
            env,
        });
        const page = await desktop.firstWindow();
        await desktop.evaluate(() => {
            (globalThis as unknown as { forceSerialProbeDenied: boolean }).forceSerialProbeDenied =
                true;
        });
        await page.evaluate(
            "document.body.innerHTML='<button id=serial-policy-probe>Probe permission</button>';document.querySelector('#serial-policy-probe').onclick=()=>navigator.serial.requestPort().then(()=>window.serialProbeResult='unexpected grant').catch(e=>window.serialProbeResult={name:e.name,message:e.message});",
        );
        await page.locator('#serial-policy-probe').click();
        await page.waitForFunction('window.serialProbeResult !== undefined');
        const actualPolicyChecks = await desktop.evaluate(
            () =>
                (
                    globalThis as unknown as {
                        serialPolicyChecks: {
                            permission: string;
                            origin: string;
                            allowed: boolean;
                            details: {
                                isMainFrame: boolean;
                                securityOrigin: string;
                                requestingUrl: string;
                            };
                        }[];
                    }
                ).serialPolicyChecks,
        );
        assert(
            actualPolicyChecks.some(
                (check) =>
                    check.permission === 'serial' &&
                    check.allowed &&
                    check.details.isMainFrame &&
                    check.details.requestingUrl === 'app://bundle/index.html' &&
                    check.origin === 'app://bundle/' &&
                    check.details.securityOrigin === 'app://bundle/',
            ),
            'The real Chromium callback must authorize only the trusted serialized root',
        );
        await desktop.evaluate(() => {
            (globalThis as unknown as { forceSerialProbeDenied: boolean }).forceSerialProbeDenied =
                false;
        });
        const api = await page.evaluate(async () => {
            const nav = navigator as Navigator & { serial?: { getPorts(): Promise<unknown[]> } };
            return {
                secure: isSecureContext,
                origin: location.origin,
                serial: typeof nav.serial,
                node: typeof (globalThis as { require?: unknown }).require,
                authorizedPorts: (await nav.serial!.getPorts()).length,
            };
        });
        assert.equal(api.secure, true);
        assert.equal(api.origin, 'app://bundle');
        assert.equal(api.serial, 'object');
        assert.equal(api.node, 'undefined');
        assert.equal(api.authorizedPorts, 0);
        const proof = await desktop.evaluate(async ({ app, BrowserWindow, session }) => {
            const state = globalThis as unknown as {
                serialWindow: InstanceType<typeof BrowserWindow>;
                serialEvents: { channel: string; args: unknown[] }[];
                checkSerial: (owner: unknown, p: string, o: string, d: unknown) => boolean;
                control: {
                    select(id: unknown, port: unknown): void;
                    acknowledge(id: unknown): void;
                    quiesce(): Promise<void>;
                    release(): void;
                };
            };
            const owner = state.serialWindow.webContents;
            const details = {
                isMainFrame: true,
                securityOrigin: 'app://bundle',
                requestingUrl: 'app://bundle/index.html',
            };
            const permissions = {
                trusted: state.checkSerial(owner, 'serial', 'app://bundle', details),
                subframe: state.checkSerial(owner, 'serial', 'app://bundle', {
                    ...details,
                    isMainFrame: false,
                }),
                unrelated: state.checkSerial({}, 'serial', 'app://bundle', details),
                opaque: state.checkSerial(owner, 'serial', 'null', details),
                otherType: state.checkSerial(owner, 'usb', 'app://bundle', details),
            };
            const replies: string[] = [];
            const offered = {
                portId: 'synthetic-port',
                portName: 'COM11',
            };
            const event = { preventDefault() {} };
            session.defaultSession.emit(
                'select-serial-port',
                event,
                [offered],
                owner,
                (id: string) => replies.push(id),
            );
            const chooser = state.serialEvents
                .filter((e) => e.channel === 'hub:serial-chooser')
                .at(-1)!.args[0] as { id: string };
            let stale = false;
            try {
                state.control.select('old', 'synthetic-port');
            } catch {
                stale = true;
            }
            session.defaultSession.emit('serial-port-removed', event, offered, owner);
            let removed = false;
            try {
                state.control.select(chooser.id, 'synthetic-port');
            } catch {
                removed = true;
            }
            session.defaultSession.emit('serial-port-added', event, offered, owner);
            state.control.select(chooser.id, 'synthetic-port');
            const listenersAfterChoice = session.defaultSession.listenerCount('serial-port-added');
            const quiesce = state.control.quiesce();
            const request = state.serialEvents
                .filter((e) => e.channel === 'hub:serial-quiesce')
                .at(-1)!.args[0];
            const blocked = state.checkSerial(owner, 'serial', 'app://bundle', details);
            let staleAck = false;
            try {
                state.control.acknowledge('old');
            } catch {
                staleAck = true;
            }
            state.control.acknowledge(request);
            await quiesce;
            state.control.release();
            let timeoutStopped = false;
            try {
                await state.control.quiesce();
            } catch {
                timeoutStopped = true;
            }
            const foreign: string[] = [];
            const other = new BrowserWindow({
                show: false,
                webPreferences: { nodeIntegration: false, sandbox: true, contextIsolation: true },
            });
            session.defaultSession.emit(
                'select-serial-port',
                event,
                [offered],
                other.webContents,
                (id: string) => foreign.push(id),
            );
            other.destroy();
            return {
                electron: process.versions.electron,
                permissions,
                replies,
                stale,
                removed,
                listenersAfterChoice,
                blocked,
                staleAck,
                timeoutStopped,
                foreign,
            };
        });
        assert.equal(proof.electron, '44.5.1');
        assert.deepEqual(proof.permissions, {
            trusted: true,
            subframe: false,
            unrelated: false,
            opaque: false,
            otherType: false,
        });
        assert.deepEqual(proof.replies, ['synthetic-port']);
        assert.deepEqual(proof.foreign, ['']);
        assert.equal(proof.stale, true);
        assert.equal(proof.removed, true);
        assert.equal(proof.listenersAfterChoice, 0);
        assert.equal(proof.blocked, false);
        assert.equal(proof.staleAck, true);
        assert.equal(proof.timeoutStopped, true);
        const evidence = {
            ...api,
            ...proof,
            actualPolicyChecks,
            realRequestForcedDenied: true,
            physicalPortsOpened: 0,
            persistentGrantsCreated: 0,
        };
        console.log(JSON.stringify(evidence, null, 2));
        if (process.env.HUB_FEATURE_EVIDENCE) {
            await mkdir(process.env.HUB_FEATURE_EVIDENCE, { recursive: true });
            await writeFile(
                path.join(process.env.HUB_FEATURE_EVIDENCE, 'serial-native-proof.json'),
                JSON.stringify(evidence, null, 2) + '\n',
            );
        }
    } finally {
        await desktop?.close();
        await rm(temporary, { recursive: true, force: true });
    }
}
void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
