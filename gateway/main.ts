import { createGateway } from './server';

function main() {
    const targets = JSON.parse(process.env.HUB_TARGETS_JSON || '[]');
    const gateway = createGateway({
        token: process.env.HUB_GATEWAY_TOKEN || '',
        origins: (process.env.HUB_ALLOWED_ORIGINS || '').split(',').filter(Boolean),
        targets,
    });
    const port = Number(process.env.HUB_GATEWAY_PORT || 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('Invalid HUB_GATEWAY_PORT.');
    const host = process.env.HUB_GATEWAY_HOST || '127.0.0.1';
    gateway.server.listen(port, host, () =>
        console.log(
            `Diagnostic Hub gateway listening on ${host}:${port}. Place behind HTTPS for website use.`,
        ),
    );
    gateway.server.on('error', () => {
        console.error('Gateway could not bind its configured address.');
        void gateway.close();
        process.exitCode = 1;
    });
    for (const signal of ['SIGINT', 'SIGTERM'])
        process.on(signal, () => {
            void gateway.close();
        });
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid gateway configuration.');
    process.exitCode = 1;
}
