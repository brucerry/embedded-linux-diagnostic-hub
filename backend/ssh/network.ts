import { performance } from 'node:perf_hooks';
import type { Probe, ProbeResult } from '../../shared/types';
import {
    outputBytes,
    shellArgument,
    unsupportedFormat,
    type CollectOptions,
    type NetworkEvidence,
    type NetworkOperation,
    type NetworkSection,
} from '../../shared/diagnostics/network/evidence';
import { records } from '../../shared/diagnostics/network/json';

export interface ExecLimits {
    timeoutMs: number;
    maxBytes: number;
}
export type NetworkExec = (id: string, command: string, limits: ExecLimits) => Promise<ProbeResult>;
const NETWORK_IDS = new Set(['interfaces', 'routes', 'ethernet', 'wireless']);
const tool = (name: 'ip' | 'iw' | 'ethtool', args: string) =>
    'if command -v ' +
    name +
    ' >/dev/null 2>&1; then ' +
    name +
    ' ' +
    args +
    '; else printf "' +
    name +
    ' is not installed.\\n" >&2; exit 127; fi';

export class NetworkCollector {
    private cache = new Map<string, NetworkSection>();
    private topology = '';
    clear() {
        this.cache.clear();
        this.topology = '';
    }
    async collect(
        probe: Probe,
        exec: NetworkExec,
        options: CollectOptions = {},
    ): Promise<ProbeResult> {
        const started = performance.now(),
            deadline = started + 12000;
        const primary = await exec(probe.id, probe.command, {
            timeoutMs: 12000,
            maxBytes: 262144,
        }).catch((error): ProbeResult => ({
            id: probe.id,
            command: probe.command,
            status: 'error',
            stdout: '',
            stderr: 'Primary command could not start: ' + String(error).slice(0, 512),
            exitCode: null,
            durationMs: Math.round(performance.now() - started),
            collectedAt: new Date().toISOString(),
            truncated: false,
        }));
        if (!NETWORK_IDS.has(probe.id)) return primary;
        const evidence: NetworkEvidence = { version: 1, sections: [], omissions: [] };
        primary.networkEvidence = evidence;
        let bytes = outputBytes(primary);
        const omit = (operation: NetworkOperation, scope: string, reason: string) => {
            if (evidence.omissions.length < 32)
                evidence.omissions.push({ operation, scope, reason });
        };
        const run = async (
            operation: NetworkOperation,
            scope: string,
            command: string,
            cached = false,
        ): Promise<NetworkSection | undefined> => {
            const key = operation + ':' + scope;
            const previous =
                cached && !options.forceNetworkCapabilities ? this.cache.get(key) : undefined;
            if (
                evidence.sections.length >= 96 ||
                bytes >= 262144 ||
                performance.now() >= deadline
            ) {
                omit(operation, scope, 'Collection budget exhausted; detail not collected.');
                return;
            }
            if (previous && bytes + outputBytes(previous) <= 262144) {
                const section = { ...previous, source: 'cached' as const };
                evidence.sections.push(section);
                bytes += outputBytes(section);
                return section;
            }
            let result: ProbeResult;
            try {
                result = await exec(key, command, {
                    timeoutMs: Math.max(1, deadline - performance.now()),
                    maxBytes: 262144 - bytes,
                });
            } catch (error) {
                omit(operation, scope, 'Command not started: ' + String(error).slice(0, 400));
                return;
            }
            const { networkEvidence: _nested, ...base } = result;
            const section: NetworkSection = {
                ...base,
                command,
                id: key,
                operation,
                scope,
                source: 'live',
            };

            evidence.sections.push(section);
            bytes += outputBytes(section);
            if (cached && section.status === 'collected' && !section.truncated)
                this.cache.set(key, section);
            return section;
        };
        const negotiate = async (
            json: NetworkOperation,
            text: NetworkOperation,
            scope: string,
            jsonCommand: string,
            textCommand: string,
        ) => {
            const result = await run(json, scope, tool('ip', jsonCommand));
            if (result && unsupportedFormat(result))
                return run(text, scope, tool('ip', textCommand));
            return result;
        };
        if (probe.id === 'interfaces') {
            await run('ip-address-json', 'all', tool('ip', '-j address show'));
        } else if (probe.id === 'routes') {
            await negotiate(
                'ip-route4-json',
                'ip-route4-text',
                'IPv4/all tables',
                '-j -4 route show table all',
                '-4 route show table all',
            );
            await negotiate(
                'ip-route6-json',
                'ip-route6-text',
                'IPv6/all tables',
                '-j -6 route show table all',
                '-6 route show table all',
            );
        } else if (probe.id === 'ethernet') {
            let links = await negotiate(
                'ip-link-json',
                'ip-link-text',
                'all',
                '-j -d -s link show',
                '-d -s link show',
            );
            if (links && unsupportedFormat(links))
                links = await run('ip-link-text', 'basic', tool('ip', 'link show'));
            await negotiate(
                'ip-neighbor-json',
                'ip-neighbor-text',
                'all',
                '-j neigh show',
                'neigh show',
            );
            let names: string[] = [];
            if (links?.status === 'collected' && links.operation === 'ip-link-json') {
                try {
                    names = records(links.stdout)
                        .filter((r) => {
                            const info = r.linkinfo as { info_kind?: unknown } | undefined;
                            return r.ifname !== 'lo' && r.link_type === 'ether' && !info?.info_kind;
                        })
                        .map((r) => String(r.ifname));
                } catch {
                    /* Raw evidence remains; sysfs names supply optional selectors. */
                }
            }
            if (!names.length)
                names = [
                    ...new Set(
                        [...primary.stdout.matchAll(/^\/sys\/class\/net\/([^/]+)\//gm)].map(
                            (m) => m[1],
                        ),
                    ),
                ].filter((n) => n !== 'lo');
            if (names.length > 16) omit('ethtool', 'all', 'First 16 optional interfaces only.');
            for (const name of names.slice(0, 16)) {
                try {
                    await run('ethtool', name, tool('ethtool', shellArgument(name)));
                } catch (error) {
                    omit('ethtool', 'unsupported selector', String(error).slice(0, 512));
                }
            }
        } else if (
            probe.id === 'wireless' &&
            primary.status === 'collected' &&
            /^phy#\d+/m.test(primary.stdout)
        ) {
            const interfaces: { name: string; mode: string; phy: string; identity: string }[] = [];
            let phy = '',
                current: (typeof interfaces)[number] | undefined;
            for (const line of primary.stdout.split('\n')) {
                const p = line.match(/^phy#(\d+)/);
                const i = line.match(/^\s*Interface\s+(.+)$/);
                const mode = line.match(/^\s*type\s+(.+)$/);
                if (p) {
                    phy = 'phy' + p[1];
                    current = undefined;
                } else if (i) {
                    current = { name: i[1].trim(), mode: '', phy, identity: '' };
                    interfaces.push(current);
                } else if (mode && current) current.mode = mode[1];
                else if (current && /^\s*(ifindex|wdev|addr)\s+/.test(line))
                    current.identity += '|' + line.trim();
            }
            const topology = interfaces
                .map((i) => i.phy + '/' + i.name + i.identity)
                .sort()
                .join('|');
            if (this.topology !== topology) {
                this.cache.clear();
                this.topology = topology;
            }
            const phys = [...new Set(interfaces.map((i) => i.phy))].filter((p) =>
                /^phy\d+$/.test(p),
            );
            if (interfaces.length > 8) omit('iw-info', 'all', 'First eight interfaces only.');
            if (phys.length > 4) omit('iw-phy', 'all', 'First four PHYs only.');
            const capabilities = async () => {
                await run('iw-version', 'tool', tool('iw', '--version'), true);
                for (const p of phys.slice(0, 4))
                    await run('iw-phy', p, tool('iw', 'phy ' + p + ' info'), true);
            };
            if (options.forceNetworkCapabilities) await capabilities();
            await run('iw-regulatory', 'global', tool('iw', 'reg get'));
            for (const iface of interfaces.slice(0, 8)) {
                let argument: string;
                try {
                    argument = shellArgument(iface.name);
                } catch (error) {
                    omit('iw-info', 'unsupported selector', String(error).slice(0, 512));
                    continue;
                }
                if (/^(managed|P2P-client)$/i.test(iface.mode))
                    await run('iw-link', iface.name, tool('iw', 'dev ' + argument + ' link'));
                await run(
                    'iw-stations',
                    iface.name,
                    tool('iw', 'dev ' + argument + ' station dump'),
                );
                await run('iw-survey', iface.name, tool('iw', 'dev ' + argument + ' survey dump'));
            }
            if (!options.forceNetworkCapabilities) await capabilities();
            for (const iface of interfaces.slice(0, 8)) {
                try {
                    await run(
                        'iw-power-save',
                        iface.name,
                        tool('iw', 'dev ' + shellArgument(iface.name) + ' get power_save'),
                    );
                } catch {
                    /* Unsafe selector already has an omission. */
                }
            }
        }
        return primary;
    }
}
