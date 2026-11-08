import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ProcessSample } from './memory-resource-verdict';
import { readProcessTable } from './memory-resource-processes';
import type { ProcessRow } from './memory-resource-processes';

let harnessCreation: string | undefined;
export async function sampleAggregateHarness(forceGc: boolean): Promise<ProcessSample> {
    if (forceGc) {
        if (typeof globalThis.gc !== 'function')
            throw Error('Qualification harness forced GC unavailable.');
        globalThis.gc();
    }
    const row = (await readProcessTable()).find((row) => row.pid === process.pid);
    assert.ok(row?.created, 'Actual qualification harness identity unavailable.');
    if (harnessCreation) assert.equal(row.created, harnessCreation);
    else harnessCreation = row.created;
    const memory = process.memoryUsage();
    return {
        pid: process.pid,
        created: row.created,
        role: 'qualification-harness',
        state: 'running',
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
        unsupported: [],
    };
}

export async function inventoryProductArtifacts(directory: string) {
    const result: { path: string; bytes: number; sha256: string }[] = [];
    async function visit(relative: string) {
        for (const item of await fs.readdir(path.join(directory, relative), {
            withFileTypes: true,
        })) {
            assert.ok(!item.isSymbolicLink());
            const name = path.join(relative, item.name);
            if (item.isDirectory()) await visit(name);
            else {
                const bytes = await fs.readFile(path.join(directory, name));
                result.push({
                    path: name.replaceAll('\\', '/'),
                    bytes: bytes.length,
                    sha256: createHash('sha256').update(bytes).digest('hex'),
                });
            }
        }
    }
    await visit('');
    return result.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

const execute = (command: string, args: string[]) =>
    new Promise<string>((resolve, reject) =>
        execFile(
            command,
            args,
            { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 ** 2 },
            (error, stdout) => (error ? reject(error) : resolve(stdout)),
        ),
    );
export interface ActualProcessLaunch {
    pid: number;
    created: string;
    executablePath: string;
    commandLine: string;
}
/** Join only requested owned identities; never infer the executable from argv text. */
export function verifyDarwinProcessFacts(
    samples: readonly ProcessSample[],
    before: readonly ProcessRow[],
    after: readonly ProcessRow[],
    paths: { pid: number; executablePath: string }[],
    commands: string,
): ActualProcessLaunch[] {
    const ids = samples.map((row) => row.pid);
    assert.ok(ids.length > 0 && ids.length <= 256 && new Set(ids).size === ids.length);
    assert.deepEqual(
        paths.map((row) => row.pid).sort((a, b) => a - b),
        [...ids].sort((a, b) => a - b),
    );
    const lines = commands
        .trim()
        .split('\n')
        .map((line) => {
            const match = /^\s*(\d+)\s+(.+)$/.exec(line);
            assert.ok(match, 'Malformed Mac command-line row.');
            return { pid: Number(match[1]), commandLine: match[2] };
        });
    assert.deepEqual(
        lines.map((row) => row.pid).sort((a, b) => a - b),
        [...ids].sort((a, b) => a - b),
    );
    return samples.map((row) => {
        const first = before.filter((value) => value.pid === row.pid);
        const last = after.filter((value) => value.pid === row.pid);
        assert.equal(first.length, 1);
        assert.equal(last.length, 1);
        assert.ok(
            row.created && first[0].created === row.created && last[0].created === row.created,
            'Mac process creation changed or is unavailable.',
        );
        const executablePath = paths.find((value) => value.pid === row.pid)!.executablePath;
        assert.ok(
            typeof executablePath === 'string' &&
                path.isAbsolute(executablePath) &&
                executablePath.length <= 4096 &&
                !executablePath.includes('\0'),
            'Invalid kernel executable path.',
        );
        const commandLine = lines.find((value) => value.pid === row.pid)!.commandLine;
        assert.ok(commandLine.length > 0 && commandLine.length <= 65536);
        return { pid: row.pid, created: row.created, executablePath, commandLine };
    });
}
export async function actualProcessLaunches(
    samples: readonly ProcessSample[],
): Promise<ActualProcessLaunch[]> {
    const live = samples.filter((row) => row.state === 'running');
    for (const row of live) assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0 && row.created);
    if (!live.length) return [];
    let facts: ActualProcessLaunch[];
    if (process.platform === 'win32') {
        const command = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in @(${live.map((row) => row.pid).join(',')}) } | Select-Object ProcessId,@{n='Created';e={$_.CreationDate.ToUniversalTime().ToString('o')}},ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
        const result = JSON.parse(
            await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]),
        );
        facts = (Array.isArray(result) ? result : [result]).map((value) => ({
            pid: Number(value.ProcessId),
            created: value.Created,
            executablePath: value.ExecutablePath,
            commandLine: value.CommandLine,
        }));
    } else if (process.platform === 'linux') {
        facts = await Promise.all(
            live.map(async (row) => {
                const stat = await fs.readFile(`/proc/${row.pid}/stat`, 'utf8');
                const created = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
                return {
                    pid: row.pid,
                    created,
                    executablePath: await fs.readlink(`/proc/${row.pid}/exe`),
                    commandLine: (await fs.readFile(`/proc/${row.pid}/cmdline`, 'utf8'))
                        .replaceAll('\0', ' ')
                        .trim(),
                };
            }),
        );
    } else if (process.platform === 'darwin') {
        assert.ok(live.length <= 256);
        const before = await readProcessTable();
        for (const row of live)
            assert.ok(
                before.some((value) => value.pid === row.pid && value.created === row.created),
                'Mac process identity unavailable before executable query.',
            );
        // macOS SDK libproc.h: int proc_pidpath(int, void *, uint32_t).
        // PROC_PIDPATHINFO_MAXSIZE is 4 * MAXPATHLEN = 4096. Read-only, requested PIDs only.
        const query = `import ctypes,json,sys
lib=ctypes.CDLL('/usr/lib/libproc.dylib',use_errno=True)
lib.proc_pidpath.argtypes=[ctypes.c_int,ctypes.c_void_p,ctypes.c_uint32]
lib.proc_pidpath.restype=ctypes.c_int
result=[]
for pid in json.loads(sys.argv[1]):
    buffer=ctypes.create_string_buffer(4096)
    if lib.proc_pidpath(pid,buffer,ctypes.sizeof(buffer)) <= 0:
        raise OSError(ctypes.get_errno(),'proc_pidpath failed for requested PID '+str(pid))
    result.append({'pid':pid,'executablePath':buffer.value.decode('utf-8')})
print(json.dumps(result))`;
        const paths = JSON.parse(
            await execute('/usr/bin/python3', [
                '-c',
                query,
                JSON.stringify(live.map((row) => row.pid)),
            ]),
        );
        const commands = await execute('/bin/ps', [
            '-ww',
            '-p',
            live.map((row) => row.pid).join(','),
            '-o',
            'pid=,command=',
        ]);
        const after = await readProcessTable();
        facts = verifyDarwinProcessFacts(live, before, after, paths, commands);
    } else
        throw Error(
            'Exact process executable/creation attribution is not implemented for this OS.',
        );
    for (const row of live) {
        const value = facts.filter((value) => value.pid === row.pid);
        assert.equal(value.length, 1, 'Actual process launch identity is absent or ambiguous.');
        assert.equal(
            value[0].created,
            row.created,
            'Process was replaced while reading launch facts.',
        );
        assert.ok(
            typeof value[0].executablePath === 'string' && path.isAbsolute(value[0].executablePath),
        );
        assert.ok(typeof value[0].commandLine === 'string' && value[0].commandLine.length > 0);
    }
    return facts;
}
export async function bindAggregateScope(
    samples: readonly ProcessSample[],
    launch: Record<string, unknown>,
) {
    const facts = await actualProcessLaunches(samples),
        identities: Record<
            string,
            {
                executablePath: string;
                executableSHA256: string;
                launch: unknown;
                metrics: { available: string[]; unavailable: string[] };
            }
        > = {};
    const hashes = new Map<string, string>();
    for (const row of samples.filter((row) => row.state === 'running')) {
        const actual = facts.find((value) => value.pid === row.pid)!;
        const executablePath = await fs.realpath(actual.executablePath);
        let executableSHA256 = hashes.get(executablePath);
        if (!executableSHA256) {
            executableSHA256 = createHash('sha256')
                .update(await fs.readFile(executablePath))
                .digest('hex');
            hashes.set(executablePath, executableSHA256);
        }
        const metrics = Object.fromEntries(
            ['rssBytes', 'heapUsedBytes', 'externalBytes', 'arrayBuffersBytes'].map((key) => [
                key,
                (row as any)[key] !== null,
            ]),
        );
        const identity = {
            executablePath,
            executableSHA256,
            launch: {
                ...launch,
                role: row.role,
                attribution:
                    'Actual PID+creation executable query; raw runtime-generated command line retained separately. Root flags and code are bound by the source/build identity.',
            },
            metrics: {
                available: Object.keys(metrics).filter((key) => metrics[key]),
                unavailable: Object.keys(metrics).filter((key) => !metrics[key]),
            },
        };
        if (identities[row.role])
            assert.deepEqual(
                identities[row.role],
                identity,
                'One declared role has heterogeneous executables or metric attribution.',
            );
        identities[row.role] = identity;
    }
    return { roles: Object.keys(identities).sort(), runtimeIdentity: identities, raw: facts };
}
