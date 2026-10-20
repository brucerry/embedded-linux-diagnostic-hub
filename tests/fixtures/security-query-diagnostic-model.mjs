import path from 'node:path';
import { fileIdentity } from '../../scripts/lib/windows-preflight.mjs';
export const root = path.resolve(import.meta.dirname, '../..');
export const exe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const principal = 'S-1-5-21-1-2-3-500';
export const identity = (file, options = {}) =>
    file === exe
        ? { path: file, sha256: 'a'.repeat(64), pe: { architecture: 'x64' } }
        : fileIdentity(file, options);
const shape = (type, count = 1, array = false) => ({ type, count, array });
function ace(sid, flags) {
    const pieces = sid.split('-').slice(1).map(Number),
        sub = pieces.slice(2),
        b = Buffer.alloc(16 + sub.length * 4);
    b[1] = flags;
    b.writeUInt16LE(b.length, 2);
    b.writeUInt32LE(0x1f01ff, 4);
    b[8] = 1;
    b[9] = sub.length;
    b.writeUIntBE(pieces[1], 10, 6);
    sub.forEach((v, i) => b.writeUInt32LE(v, 16 + i * 4));
    return { type: 0, flags, binary: b.toString('base64') };
}
export function modelReply(c, script = path.join(root, 'scripts/lib/hosted-pilot-security.ps1')) {
    const interpreter = {
        path: exe,
        script,
        version: '5.1.26100.1234',
        edition: 'Desktop',
        x64: true,
    };
    const trace = {
        root: shape('System.Object[]', Array.isArray(c.plans) ? c.plans.length : 1, true),
        rootElements: [],
        rows: [],
        getItemCalls: 0,
        getAclCalls: 0,
        red: null,
    };
    const reply = {
        schema: 1,
        complete: c.expected === 'green',
        principal,
        interpreter,
        trace,
        rows: [],
        error: null,
    };
    if (c.expected === 'legacy-red') {
        trace.root = shape('System.Object[]', 1, true);
        trace.rootElements = [shape('System.Object[]', 2, true)];
        trace.red = {
            plan: shape('System.Object[]', 2, true),
            path: shape('System.Object[]', 2, true),
            item: shape('System.Object[]', 2, true),
            attributes: shape('System.Object[]', 2, true),
            itemTypes: ['System.IO.DirectoryInfo', 'System.IO.DirectoryInfo'],
        };
        trace.getItemCalls = 1;
        reply.error = {
            id: 'MethodNotFound',
            message: 'System.Object[] does not contain op_BitwiseAnd',
        };
    } else if (c.expected === 'green')
        for (const plan of c.plans) {
            trace.rootElements.push(shape('System.Management.Automation.PSCustomObject'));
            trace.getItemCalls++;
            trace.getAclCalls++;
            trace.rows.push({
                plan: shape('System.Management.Automation.PSCustomObject'),
                path: shape('System.String'),
                kind: shape('System.String'),
                item: shape(
                    plan.kind === 'file' ? 'System.IO.FileInfo' : 'System.IO.DirectoryInfo',
                ),
                attributes: shape('System.IO.FileAttributes'),
                container: shape('System.Boolean'),
                acl: shape(
                    plan.kind === 'file'
                        ? 'System.Security.AccessControl.FileSecurity'
                        : 'System.Security.AccessControl.DirectorySecurity',
                ),
            });
            reply.rows.push({
                path: plan.path,
                kind: plan.kind,
                owner: 'S-1-5-32-544',
                group: 'S-1-5-21-1-2-3-513',
                daclPresent: true,
                daclNull: false,
                aces: ['S-1-5-18', 'S-1-5-32-544', principal].map((s) =>
                    ace(s, plan.kind === 'file' ? 16 : 19),
                ),
                binary: Buffer.alloc(32, 1).toString('base64'),
            });
        }
    else {
        trace.getItemCalls = c.expected === 'reject-before-provider' ? 0 : 1;
        trace.getAclCalls = c.expected === 'reject-kind' ? 1 : 0;
        reply.error = {
            id: 'controlled-unit-rejection',
            message: 'Controlled reply for Node boundary tests only',
        };
    }
    return reply;
}
