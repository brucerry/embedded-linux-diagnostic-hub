import { validateInventory } from './inventory';
import { draftProfile } from './profile';
import { blankEvidence, TestController, utf8Hex } from './runner';
import type { BoardProfile, Inventory, TestingTransport } from './types';

export function simulatedInventory(): Inventory {
    const resources = [
        {
            id: 'led',
            domain: 'led',
            name: 'green:status',
            path: '/sys/class/leds/green:status',
            ofNode: '/leds/status',
            controller: '',
            identity: 'status LED',
            address: null,
            console: false,
            writable: true,
            metadata: { maxBrightness: '255', trigger: '[none] heartbeat' },
        },
        {
            id: 'uart',
            domain: 'uart',
            name: 'service-uart',
            path: '/dev/ttyS1',
            ofNode: '/soc/serial@1000',
            controller: '',
            identity: 'simulated UART',
            address: null,
            console: false,
            writable: true,
            metadata: {},
        },
        {
            id: 'i2c',
            domain: 'i2c',
            name: 'identity-fixture',
            path: '/sys/bus/i2c/devices/4-0048',
            ofNode: '/soc/i2c@2000/sensor@48',
            controller: '/soc/i2c@2000',
            identity: 'simulated identity fixture',
            address: 72,
            console: false,
            writable: true,
            metadata: { bus: '4', busy: 'no' },
        },
    ];
    return validateInventory({
        schemaVersion: 1,
        id: 'simulated-inventory',
        mode: 'simulated',
        capturedAt: new Date().toISOString(),
        endpoint: 'simulated-board',
        username: 'simulation',
        complete: true,
        issues: [],
        device: {
            model: 'Simulated engineering board',
            compatible: ['diagnostic-hub,simulation'],
            kernel: 'Simulated Linux',
            firmware: 'Simulation 1',
            serial: 'SIM-001',
            bootId: 'simulated-boot',
        },
        capabilities: { python3: true, i2cget: true, timeout: true },
        nodes: [
            {
                path: '/',
                properties: { compatible: '646961676e6f737469632d6875622c73696d756c6174696f6e00' },
            },
        ],
        resources,
    });
}
export function sampleProfile(): BoardProfile {
    const p = draftProfile(simulatedInventory());
    p.id = 'simulation-bench';
    p.name = 'Engineering bench example';
    p.boardRevision = 'Example A';
    for (const test of p.tests) {
        if (test.adapter === 'led.pattern') {
            test.name = 'Status LED pattern';
            test.fixture = 'Observer can see the green status LED.';
            test.expected = 'Three green flashes.';
            test.parameters.level = 255;
        }
        if (test.adapter === 'uart.loopback') {
            test.name = 'Service UART loopback';
            test.fixture = 'Approved TX/RX loopback fixture on the service UART.';
            test.expected = 'Receive every transmitted byte unchanged.';
        }
        if (test.adapter === 'i2c.identity') {
            test.name = 'Sensor identity';
            test.fixture =
                'Approved identity fixture at address 0x48; register 0x00 is safe to read.';
            test.expected = 'Register 0x00 returns 0x44.';
            test.parameters.register = 0;
            test.parameters.expected = 68;
        }
    }
    return p;
}
export function createSimulation(
    options: { uartFault?: boolean; delayMs?: number } = {},
): TestingTransport {
    const controller = new TestController(
        async () => simulatedInventory(),
        async (c, signal) => {
            const started = Date.now();
            await new Promise<void>((resolve) => {
                if (signal.aborted) return resolve();
                const finish = () => {
                    clearTimeout(timer);
                    signal.removeEventListener('abort', finish);
                    resolve();
                };
                const timer = setTimeout(finish, options.delayMs ?? 650);
                signal.addEventListener('abort', finish, { once: true });
            });
            if (signal.aborted)
                return {
                    ...blankEvidence('interrupted', 'Simulation cancelled.'),
                    cleanup: 'verified',
                    cleanupDetail: 'Simulated settings restored.',
                    durationMs: Date.now() - started,
                };
            const measured =
                c.test.adapter === 'i2c.identity'
                    ? 68
                    : c.test.adapter === 'uart.loopback'
                      ? options.uartFault
                          ? '00'
                          : utf8Hex(String(c.test.parameters.payload))
                      : 'pattern-executed';
            return {
                ...blankEvidence(
                    'ok',
                    'Simulated execution completed; this is not hardware qualification.',
                ),
                measured,
                stdout: `SIMULATED ${c.test.adapter}: ${measured}\n`,
                exitCode: 0,
                durationMs: Date.now() - started,
                cleanup: c.test.adapter === 'i2c.identity' ? 'not-needed' : 'verified',
                cleanupDetail: 'Simulated original state restored.',
            };
        },
    );
    return {
        clearTests: async () => controller.clear(),
        discoverTests: () => controller.discoverInventory(),
        prepareTests: (p) => controller.prepare(p),
        startTests: (r) => controller.start(r),
        readTestRun: async () => controller.readProgress(),
        cancelTests: (id) => controller.cancel(id),
        confirmTest: async (r) => controller.confirm(r),
    };
}
