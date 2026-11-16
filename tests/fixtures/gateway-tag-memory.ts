import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import { createExpectedGatewayTagReader } from '../../scripts/lib/gateway-tag-reader.mjs';
import { gitObjectID, sourceDigest } from '../../scripts/lib/committed-source-bridge.mjs';
import { memoryFilesystem } from './gateway-producer-memory';
export const prefix = [
    '--no-replace-objects',
    '--no-pager',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.untrackedCache=false',
];
const environment = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' };
export type ObjectData = { oid: string; type: string; bytes: Buffer };
export const commit = (tree = 'a'.repeat(40)): ObjectData => {
    const bytes = Buffer.from(
        `tree ${tree}\nauthor Synthetic <test@example.invalid> 0 +0000\ncommitter Synthetic <test@example.invalid> 0 +0000\n\nMemory only.\n`,
    );
    return { oid: gitObjectID('commit', bytes), type: 'commit', bytes };
};
export function tag(target: ObjectData, type = target.type): ObjectData {
    const bytes = Buffer.from(
        `object ${target.oid}\ntype ${type}\ntag v0.6.0\n\nMemory tag only.\n`,
    );
    return { oid: gitObjectID('tag', bytes), type: 'tag', bytes };
}
export function tagReaderFixture(layers = 1, source = commit()) {
    const fs = memoryFilesystem();
    fs.write('/tools/git', Buffer.from('Memory Git bytes, never executed.'));
    const objects = [source];
    for (let n = 0; n < layers; n++) objects.unshift(tag(objects[0]));
    const selected = {
        root: '/project',
        gitPath: '/tools/git',
        gitSHA256: sourceDigest(fs.bytes('/tools/git')),
        environment,
        tagRef: 'refs/tags/v0.6.0',
        tagObjectID: objects[0].oid,
        sourceCommit: source.oid,
        sourceTree: source.bytes.toString().split('\n')[0].slice(5),
    };
    const calls: { tail: string[]; input?: string }[] = [],
        timers = new Set<Function>();
    const controls: any = {};
    let now = 0;
    function response(tail: string[], input?: string): { out: Buffer; code: number; err?: Buffer } {
        if (tail[0] === 'rev-parse')
            return {
                out: Buffer.from(
                    (
                        {
                            '--show-toplevel': selected.root,
                            '--show-object-format': 'sha1',
                            '--verify':
                                tail[2] === 'HEAD' ? selected.sourceCommit : selected.sourceTree,
                        } as any
                    )[tail[1]] + '\n',
                ),
                code: 0,
            };
        if (tail[0] === 'config') return { out: Buffer.alloc(0), code: 1 };
        if (tail[0] === 'show-ref')
            return { out: Buffer.from(selected.tagObjectID + '\n'), code: 0 };
        const object = objects.find((o) => o.oid + '\n' === input)!;
        assert.ok(object, 'No unrelated object lookup in memory fixture.');
        const header = Buffer.from(`${object.oid} ${object.type} ${object.bytes.length}\n`);
        return {
            out:
                tail[1] === '--batch-check'
                    ? header
                    : Buffer.concat([header, object.bytes, Buffer.from('\n')]),
            code: 0,
        };
    }
    const ports: any = {
        filesystem: {
            ...fs.fs,
            async open(p: string, flags: number) {
                assert.ok(flags & constants.O_NOFOLLOW);
                return fs.fs.open(p, 'r');
            },
            async opendir() {
                throw Error('Not a reader operation.');
            },
        },
        now: () => now,
        setTimer(fn: Function) {
            timers.add(fn);
            return fn;
        },
        clearTimer(fn: Function) {
            timers.delete(fn);
        },
        launch(_binary: string, args: string[], options: any) {
            const tail = args.slice(prefix.length);
            const call = { tail, input: undefined as string | undefined };
            calls.push(call);
            controls.beforeLaunch?.(call, calls.length);
            const child: any = new EventEmitter();
            child.pid = 100 + calls.length;
            child.exitCode = null;
            child.signalCode = null;
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.stdin = options.stdio[0] === 'pipe' ? new EventEmitter() : null;
            if (child.stdin)
                child.stdin.end = (bytes: Buffer, ack: Function) => {
                    call.input = bytes.toString();
                    child.stdin.emit('finish');
                    ack(null);
                    child.stdin.emit('close');
                    return child.stdin;
                };
            assert.equal(options.shell, false);
            assert.deepEqual(
                Object.keys(options.env).sort(),
                [
                    'PATH',
                    'LANG',
                    'LC_ALL',
                    'TZ',
                    'GIT_NO_LAZY_FETCH',
                    'GIT_OPTIONAL_LOCKS',
                    'GIT_TERMINAL_PROMPT',
                    'GIT_CONFIG_GLOBAL',
                    'GIT_CONFIG_NOSYSTEM',
                ].sort(),
            );
            assert.equal(options.env.GIT_CONFIG_GLOBAL, '/dev/null');
            queueMicrotask(() => {
                child.emit('spawn');
                let r = response(tail, call.input);
                r = controls.response?.(call, r, calls.length) ?? r;
                controls.afterResponse?.(call, calls.length, child);
                if (controls.expireChild) {
                    for (const timer of timers) timer();
                    return;
                }
                if (r.out.length) child.stdout.emit('data', r.out);
                if (r.err?.length) child.stderr.emit('data', r.err);
                child.stdout.emit('close');
                child.stderr.emit('close');
                child.emit('exit', r.code, null);
                child.emit('close', r.code, null);
            });
            return child;
        },
    };
    return {
        selected,
        ports,
        calls,
        controls,
        objects,
        fs,
        timers,
        setNow: (v: number) => {
            now = v;
        },
        reader: () => createExpectedGatewayTagReader(selected, ports),
    };
}
