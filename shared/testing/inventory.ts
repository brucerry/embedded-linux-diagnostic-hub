import { DOMAINS, INVENTORY_BYTES, type Inventory, type Resource } from './types';
import { bool, bounded, choice, date, id, list, number, object, text, unique } from './validation';

function strings(
    input: unknown,
    label: string,
    count: number,
    max: number,
): Record<string, string> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        throw Error(`${label}: invalid map.`);
    const entries = Object.entries(input);
    if (entries.length > count) throw Error(`${label}: too many fields.`);
    const result: Record<string, string> = {};
    for (const [key, value] of entries) {
        if (['__proto__', 'constructor', 'prototype'].includes(key))
            throw Error(`${label}: invalid key.`);
        result[text(key, label, 128, false)] = text(value, label, max);
    }
    return result;
}
export function validateResource(input: unknown): Resource {
    const v = object(
        input,
        [
            'id',
            'domain',
            'name',
            'path',
            'ofNode',
            'controller',
            'identity',
            'address',
            'console',
            'writable',
            'metadata',
        ],
        'Observed resource',
    );
    const domain = choice(v.domain, DOMAINS, 'Domain');
    const path = text(v.path, 'Runtime path', 512, false);
    if (!path.startsWith('/') || path.split('/').includes('..') || /[\r\n\t]/.test(path))
        throw Error('Invalid runtime path.');
    if (domain === 'led' && !/^\/sys\/class\/leds\/[^/]+$/.test(path))
        throw Error('Invalid LED class resource.');
    if (domain === 'uart' && !/^\/dev\/[^/]+$/.test(path)) throw Error('Invalid UART resource.');
    if (domain === 'i2c' && !/^\/sys\/bus\/i2c\/devices\/\d+-[0-9a-f]{4}$/.test(path))
        throw Error('Invalid I2C resource.');
    return {
        id: id(v.id, 'Observed resource ID'),
        domain,
        name: text(v.name, 'Resource name'),
        path,
        ofNode: text(v.ofNode, 'DT node'),
        controller: text(v.controller, 'Controller'),
        identity: text(v.identity, 'Identity'),
        address: v.address === null ? null : number(v.address, 'Address', 0, 1023),
        console: bool(v.console, 'Console'),
        writable: bool(v.writable, 'Writable'),
        metadata: strings(v.metadata, 'Resource metadata', 32, 4096),
    };
}
export function validateInventory(input: unknown): Inventory {
    bounded(input, INVENTORY_BYTES, 'Inventory');
    const v = object(
        input,
        [
            'schemaVersion',
            'id',
            'mode',
            'capturedAt',
            'endpoint',
            'username',
            'complete',
            'issues',
            'device',
            'capabilities',
            'nodes',
            'resources',
        ],
        'Inventory',
    );
    if (v.schemaVersion !== 1) throw Error('Unsupported inventory schema.');
    const d = object(
        v.device,
        ['model', 'compatible', 'kernel', 'firmware', 'serial', 'bootId'],
        'Device identity',
    );
    const c = object(v.capabilities, ['python3', 'i2cget', 'timeout'], 'Capabilities');
    return {
        schemaVersion: 1,
        id: id(v.id, 'Inventory ID'),
        mode: choice(v.mode, ['ssh', 'simulated'], 'Source'),
        capturedAt: date(v.capturedAt, 'Captured'),
        endpoint: text(v.endpoint, 'Endpoint'),
        username: text(v.username, 'Username', 64),
        complete: bool(v.complete, 'Complete'),
        issues: list(v.issues, 'Issues', 128).map((x) => text(x, 'Issue', 1024)),
        device: {
            model: text(d.model, 'Model'),
            compatible: list(d.compatible, 'Compatible', 64).map((x) => text(x, 'Compatible')),
            kernel: text(d.kernel, 'Kernel'),
            firmware: text(d.firmware, 'Firmware', 2048),
            serial: text(d.serial, 'Serial'),
            bootId: text(d.bootId, 'Boot identity', 128),
        },
        capabilities: {
            python3: bool(c.python3, 'Python'),
            i2cget: bool(c.i2cget, 'I2C tool'),
            timeout: bool(c.timeout, 'Timeout'),
        },
        nodes: unique(
            list(v.nodes, 'DT nodes', 4096).map((raw) => {
                const n = object(raw, ['path', 'properties'], 'DT node');
                return {
                    path: text(n.path, 'Node path'),
                    properties: strings(n.properties, 'DT properties', 64, 16384),
                };
            }),
            (n) => n.path,
            'DT nodes',
        ),
        resources: unique(
            list(v.resources, 'Runtime resources', 1024).map(validateResource),
            (r) => r.id,
            'Runtime resources',
        ),
    };
}
export function decodeHex(value: string): Uint8Array {
    if (value.length > 16384 || !/^(?:[0-9a-f]{2})*$/.test(value))
        throw Error('Malformed binary discovery field.');
    return Uint8Array.from(value.match(/../g) || [], (x) => parseInt(x, 16));
}
export function dtStrings(value: string): string[] {
    return new TextDecoder('utf-8', { fatal: true })
        .decode(decodeHex(value))
        .split('\0')
        .filter(Boolean);
}
export function dtCells(value: string): number[] {
    const bytes = decodeHex(value);
    if (bytes.length % 4) throw Error('DT property is not a cell array.');
    const view = new DataView(bytes.buffer);
    return Array.from({ length: bytes.length / 4 }, (_, i) => view.getUint32(i * 4, false));
}
export function dtReferences(
    inventory: Inventory,
    property: string,
    value: string,
): { provider: string; cells: number[] }[] {
    const cells = dtCells(value),
        references = [];
    for (let i = 0; i < cells.length;) {
        const handle = cells[i++];
        const provider = inventory.nodes.find((n) => {
            const p = n.properties.phandle || n.properties['linux,phandle'];
            return p && dtCells(p)[0] === handle;
        });
        const counts = provider?.properties[`#${property}-cells`];
        if (!provider || !counts) throw Error('Unknown DT reference binding; retain raw evidence.');
        const count = dtCells(counts)[0];
        if (count > 32 || i + count > cells.length) throw Error('Invalid DT provider cell count.');
        references.push({ provider: provider.path, cells: cells.slice(i, (i += count)) });
    }
    return references;
}
export function parseDiscovery(output: string, endpoint: string, username: string): Inventory {
    if (new TextEncoder().encode(output).length > INVENTORY_BYTES)
        throw Error('Discovery exceeded its output limit.');
    const inventory: Inventory = {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        mode: 'ssh',
        capturedAt: new Date().toISOString(),
        endpoint,
        username,
        complete: true,
        issues: [],
        device: { model: '', compatible: [], kernel: '', firmware: '', serial: '', bootId: '' },
        capabilities: { python3: false, i2cget: false, timeout: false },
        nodes: [],
        resources: [],
    };
    const lines = output.trimEnd().split('\n');
    if (lines.shift() !== 'HUB-INVENTORY-1' || lines.pop() !== 'HUB-INVENTORY-END')
        throw Error('Incomplete or unsupported discovery response.');
    const decode = (x: string) => new TextDecoder('utf-8', { fatal: true }).decode(decodeHex(x));
    for (const line of lines) {
        const p = line.split('\t');
        if (
            p[0] === 'D' &&
            p.length === 3 &&
            ['model', 'kernel', 'firmware', 'serial', 'bootId'].includes(p[1])
        )
            (inventory.device as unknown as Record<string, unknown>)[p[1]] = decode(p[2]);
        else if (
            p[0] === 'C' &&
            p.length === 3 &&
            ['python3', 'i2cget', 'timeout'].includes(p[1]) &&
            /^[01]$/.test(p[2])
        )
            (inventory.capabilities as unknown as Record<string, unknown>)[p[1]] = p[2] === '1';
        else if (p[0] === 'N' && p.length === 4) {
            const path = decode(p[1]),
                key = decode(p[2]);
            decodeHex(p[3]);
            let node = inventory.nodes.find((n) => n.path === path);
            if (!node) {
                node = { path, properties: {} };
                inventory.nodes.push(node);
            }
            if (
                ['__proto__', 'constructor', 'prototype'].includes(key) ||
                Object.hasOwn(node.properties, key)
            )
                throw Error('Invalid DT property.');
            node.properties[key] = p[3];
            if (path === '/' && key === 'compatible') inventory.device.compatible = dtStrings(p[3]);
        } else if (p[0] === 'E' && p.length === 2) {
            inventory.complete = false;
            inventory.issues.push(decode(p[1]));
        } else if (p[0] === 'R' && p.length === 14) {
            const [
                domain,
                name,
                path,
                ofNode,
                controller,
                identity,
                address,
                console,
                writable,
                maxBrightness,
                bus,
                busy,
                trigger,
            ] = p.slice(1).map(decode);
            if (
                !/^[01]$/.test(console) ||
                !/^[01]$/.test(writable) ||
                (address && !/^\d+$/.test(address))
            )
                throw Error('Malformed runtime resource flags/address.');
            inventory.resources.push({
                id: `resource-${inventory.resources.length + 1}`,
                domain: domain as Resource['domain'],
                name,
                path,
                ofNode,
                controller,
                identity,
                address: address ? Number(address) : null,
                console: console === '1',
                writable: writable === '1',
                metadata: { maxBrightness, bus, busy, trigger },
            });
        } else throw Error('Malformed discovery record.');
    }
    return validateInventory(inventory);
}
