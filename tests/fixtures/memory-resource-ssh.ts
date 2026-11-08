import assert from 'node:assert/strict';
import { gatewayFixture } from './gateway';
import { SshSession } from '../../backend/ssh/session';
import { sshCaptureBackend } from '../../src/features/automation/capture/ssh-backend';
import { FlowRunner } from '../../src/features/automation/runner';
import type { AutomationPlan } from '../../shared/automation';
import type { CaptureRepository } from '../../shared/capture-store';
import { Owners, captureDiagnostic } from './memory-resource-core';
import { deferred, until } from './serial-capture';
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Real authenticated loopback SSH, production stream/ACK/client/runner; synthetic bytes only. */
export async function sshCycle(store: CaptureRepository, payloadBytes: number, owners: Owners) {
    let channels = 0,
        pumps = 0,
        writes = 0;
    const server = await gatewayFixture(undefined, {
        exec: (_command, channel) => {
            writes++;
            channels++;
            const release = owners.take('channel', 'loopback exec');
            channel.once('close', () => {
                channels--;
                release();
            });
            channel.on('error', () => {});
            channel.on('end', () => channel.close());
            channel.resume();
            pumps++;
            const done = owners.take('producer', 'stdout/stderr pump');
            void (async () => {
                try {
                    for (
                        let offset = 0;
                        offset < payloadBytes && !channel.destroyed;
                        offset += 16384
                    ) {
                        const sink = offset % 32768 ? channel.stderr : channel;
                        await new Promise<void>((resolve, reject) =>
                            sink.write(
                                Buffer.alloc(Math.min(16384, payloadBytes - offset), 65),
                                (error) => (error ? reject(error) : resolve()),
                            ),
                        );
                    }
                    if (!channel.destroyed) {
                        channel.exit(0);
                        channel.end();
                    }
                } catch {
                    channel.close();
                } finally {
                    pumps--;
                    done();
                }
            })();
            return true;
        },
    });
    const ssh = new SshSession();
    const releaseServer = owners.take('server', 'authenticated loopback');
    try {
        await ssh.connect(server.options, async (value) => value === server.pinned);
        const rpc = (request: Parameters<SshSession['automationStream']>[0]) =>
            owners.join('rpc-ack', 'SSH stream request', () => ssh.automationStream(request));
        const transport = {
            automationStream: rpc,
            automationConnection: () => ssh.automationConnection,
        };
        const makePlan = (commands: string[]): AutomationPlan => ({
            transport: 'ssh',
            start: null,
            repeatSeconds: null,
            timeoutSeconds: 30,
            serial: { lineEnding: 'CR', prompt: 'board# ', timestampPrefix: '' },
            steps: commands.map((command, i) => ({
                id: `ssh-step-${i}`,
                command,
                name: command,
                enabled: true,
                delaySeconds: 0,
            })),
        });
        let completion = '',
            lastState = '',
            lastMessage = '';
        let phase = 'initial';
        let lastCapture: ReturnType<typeof captureDiagnostic> | null = null;
        const runner = new FlowRunner(
            (state) => {
                lastState = state.state;
                lastMessage = state.message;
            },
            (row) => {
                completion = row.completion;
                lastCapture = captureDiagnostic(row);
            },
        );
        await runner.start(
            makePlan(['fixture']),
            sshCaptureBackend(
                transport,
                store,
                'local-client',
                { endpoint: 'synthetic loopback' },
                () => ssh.isConnected,
            ),
        );
        const details = () =>
            JSON.stringify({ phase, lastState, lastMessage, lastCapture, writes, channels, pumps });
        assert.equal(lastState, 'finished', details());
        assert.equal(completion, 'exit');
        await until(() => channels === 0 && pumps === 0);
        const gate = deferred();
        let entered = false;
        phase = 'cancel';
        const slow = new Proxy(store, {
            get(target, key) {
                if (key === 'append')
                    return async (...args: Parameters<CaptureRepository['append']>) => {
                        entered = true;
                        await gate.promise;
                        return target.append(...args);
                    };
                return Reflect.get(target, key);
            },
        });
        const pending = runner.start(
            makePlan(['cancelled', 'never-send']),
            sshCaptureBackend(
                transport,
                slow,
                'local-client',
                { endpoint: 'synthetic loopback' },
                () => ssh.isConnected,
            ),
        );
        try {
            await until(() => entered);
            runner.cancel();
            await turn();
            assert.equal(runner.busy, true, 'SSH pending append retains cleanup ownership.');
        } finally {
            gate.resolve();
        }
        await pending;
        assert.equal(completion, 'cancelled');
        assert.equal(writes, 2);
        assert.equal(runner.busy, false);
        assert.equal(channels, 0, 'Runner completion must join channel close.');
        await until(() => pumps === 0);
        phase = 'rearm';
        await runner.start(
            makePlan(['rearmed']),
            sshCaptureBackend(
                transport,
                store,
                'local-client',
                { endpoint: 'synthetic loopback' },
                () => ssh.isConnected,
            ),
        );
        assert.equal(writes, 3);
        assert.equal(lastState, 'finished', details());
    } finally {
        ssh.disconnect();
        await until(() => server.connectedSessions() === 0 && channels === 0 && pumps === 0);
        await server.close();
        releaseServer();
        assert.equal(ssh.isConnected, false);
    }
}
