import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
    startOwnedExpectedTagGitRead,
    GIT_READ_BOUNDS,
    validateExpectedGatewayTagRef,
} from './owned-git-read.mjs';
import { createOwnedWebFiles } from './owned-web-files.mjs';
import { webChildEnvironments } from './owned-web-capabilities.mjs';
import { readStableArtifactFile } from './stable-artifact-file.mjs';
import {
    inspectGatewayReleaseObject,
    GATEWAY_RELEASE_BINDING_LIMITS as limits,
} from './gateway-release-producer.mjs';

export const GATEWAY_TAG_READ_LIMITS = Object.freeze({ commands: 25, observationMs: 60000 });
const retained = new Set();
const prefix = [
    '--no-replace-objects',
    '--no-pager',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.untrackedCache=false',
];
const partialQuery = [
    'config',
    '--includes',
    '--name-only',
    '--get-regexp',
    '^(extensions\\.partialclone|remote\\..*\\.promisor)$',
];
const sha40 = /^[a-f0-9]{40}$/;
const digest = (b) => createHash('sha256').update(b).digest('hex');
function absolute(value) {
    assert.ok(
        typeof value === 'string' &&
            value.startsWith('/') &&
            value !== '/' &&
            value.length <= 4096 &&
            path.posix.normalize(value) === value &&
            !/[\\\x00-\x1f\x7f]/.test(value),
    );
}
function line(bytes) {
    assert.ok(Buffer.isBuffer(bytes) && bytes.length > 1 && bytes.length <= 4097);
    const text = bytes.toString('utf8');
    assert.ok(
        Buffer.from(text).equals(bytes) &&
            !/[\x00-\x1f\x7f]/.test(text.slice(0, -1)) &&
            text.endsWith('\n'),
    );
    return text.slice(0, -1);
}
export class GatewayTagReadFailure extends Error {
    constructor(cause, reader) {
        super('Expected tag read failed; custody retained.', { cause });
        this.reader = reader;
    }
}
/** One-shot local observation only. No native defaults, fallback refs or release admission.
 * Selection pins are caller inputs, not authenticated publisher/service authority.
 * A stable endpoint observation cannot exclude an intervening change and restore.
 */
export function createExpectedGatewayTagReader(selection, ports) {
    assert.deepEqual(Object.keys(selection).sort(), [
        'environment',
        'gitPath',
        'gitSHA256',
        'root',
        'sourceCommit',
        'sourceTree',
        'tagObjectID',
        'tagRef',
    ]);
    const selected = structuredClone(selection);
    absolute(selected.root);
    absolute(selected.gitPath);
    assert.match(selected.gitSHA256, /^[a-f0-9]{64}$/);
    for (const key of ['sourceCommit', 'sourceTree', 'tagObjectID'])
        assert.match(selected[key], sha40);
    validateExpectedGatewayTagRef(selected.tagRef);
    for (const key of ['launch', 'setTimer', 'clearTimer', 'now'])
        assert.equal(typeof ports?.[key], 'function');
    const files = createOwnedWebFiles(ports.filesystem);
    const env = Object.freeze({
        ...webChildEnvironments(selected.environment).git,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
    });
    const owners = new Set();
    let used = false,
        failed = false,
        complete = false,
        commands = 0,
        closedCommands = 0,
        started,
        last;
    function time() {
        const value = ports.now();
        assert.ok(Number.isFinite(value) && (last === undefined || value >= last));
        last = value;
        return value;
    }
    function within() {
        const elapsed = time() - started;
        assert.ok(
            elapsed >= 0 && elapsed <= GATEWAY_TAG_READ_LIMITS.observationMs,
            'Tag observation deadline exceeded.',
        );
        return elapsed;
    }
    async function verifyGit() {
        const { bytes } = await readStableArtifactFile(
            path.posix.dirname(selected.gitPath),
            path.posix.basename(selected.gitPath),
            16 * 1024 ** 2,
            files.filesystem,
        );
        assert.equal(digest(bytes), selected.gitSHA256, 'Selected Git executable changed.');
    }
    async function query(tail, input, maximum = 4097, emptyConfig = false) {
        assert.ok(!failed && commands < GATEWAY_TAG_READ_LIMITS.commands);
        assert.ok(
            within() <= GATEWAY_TAG_READ_LIMITS.observationMs - GIT_READ_BOUNDS.deadlineMs,
            'Insufficient remaining tag observation time.',
        );
        await verifyGit();
        assert.ok(within() <= GATEWAY_TAG_READ_LIMITS.observationMs - GIT_READ_BOUNDS.deadlineMs);
        commands++;
        const child = startOwnedExpectedTagGitRead(
            {
                executable: selected.gitPath,
                args: [...prefix, ...tail],
                cwd: selected.root,
                env,
                input,
                maximum,
            },
            selected.tagRef,
            ports,
        );
        owners.add(child);
        let value;
        try {
            value = await child.result;
        } finally {
            if (child.snapshot().directRetired) {
                owners.delete(child);
                closedCommands++;
            }
        }
        within();
        assert.ok(value.stderr.length === 0);
        assert.equal(value.code, emptyConfig ? 1 : 0);
        if (emptyConfig) assert.equal(value.stdout.length, 0);
        await verifyGit();
        within();
        return value.stdout;
    }
    const reader = Object.freeze({
        snapshot() {
            return Object.freeze({
                used,
                failed,
                complete,
                commands,
                closedCommands,
                retainedChildren: owners.size,
                files: files.owner.snapshot(),
                processGroupRetirement: null,
                publisherProvenance: null,
                releaseAcceptance: false,
            });
        },
        assertSettled() {
            assert.ok(complete && !failed && owners.size === 0);
            files.owner.assertSettled();
        },
        async read() {
            assert.ok(!used, 'Expected tag reader is one-shot.');
            used = true;
            retained.add(reader);
            try {
                started = time();
                assert.equal(await files.filesystem.realpath(selected.root), selected.root);
                const rootStat = await files.filesystem.lstat(selected.root);
                assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink());
                assert.equal(line(await query(['rev-parse', '--show-toplevel'])), selected.root);
                assert.equal(line(await query(['rev-parse', '--show-object-format'])), 'sha1');
                assert.equal(
                    line(await query(['rev-parse', '--verify', 'HEAD'])),
                    selected.sourceCommit,
                );
                assert.equal(
                    line(await query(['rev-parse', '--verify', 'HEAD^{tree}'])),
                    selected.sourceTree,
                );
                await query(partialQuery, undefined, 4097, true);
                const ref = async () => {
                    const objectID = line(
                        await query(['show-ref', '--verify', '--hash', selected.tagRef]),
                    );
                    assert.equal(objectID, selected.tagObjectID, 'Selected release tag changed.');
                    return Object.freeze({ ref: selected.tagRef, objectID });
                };
                const refBefore = await ref(),
                    objects = [],
                    seen = new Set();
                let wanted = selected.tagObjectID,
                    wantedType = null,
                    total = 0,
                    annotations = 0;
                for (;;) {
                    assert.ok(!seen.has(wanted) && objects.length < limits.annotations + 1);
                    seen.add(wanted);
                    const input = `${wanted}\n`;
                    const metadata = line(await query(['cat-file', '--batch-check'], input, 1024));
                    const parsed = /^([a-f0-9]{40}) (tag|commit) ([1-9][0-9]{0,6})$/.exec(metadata);
                    assert.ok(
                        parsed && parsed[1] === wanted,
                        'Unexpected selected object metadata.',
                    );
                    const type = parsed[2],
                        size = Number(parsed[3]);
                    if (wantedType !== null) assert.equal(type, wantedType);
                    if (type === 'commit')
                        assert.equal(wanted, selected.sourceCommit, 'Tag targets another source.');
                    else assert.ok(++annotations <= limits.annotations);
                    assert.ok(size <= (type === 'tag' ? limits.tagBytes : limits.commitBytes));
                    total += size;
                    assert.ok(total <= limits.totalObjectBytes);
                    const raw = await query(['cat-file', '--batch'], input, size + 128);
                    const header = Buffer.from(metadata + '\n');
                    assert.ok(
                        raw.length === header.length + size + 1 &&
                            raw.subarray(0, header.length).equals(header) &&
                            raw.at(-1) === 10,
                        'Unexpected selected object framing.',
                    );
                    const object = {
                        oid: wanted,
                        type,
                        bytes: Buffer.from(raw.subarray(header.length, -1)),
                    };
                    const inspected = inspectGatewayReleaseObject(object);
                    objects.push(object);
                    if (type === 'commit') {
                        assert.equal(inspected.tree, selected.sourceTree);
                        break;
                    }
                    wanted = inspected.target;
                    wantedType = inspected.targetType;
                    if (wantedType === 'commit')
                        assert.equal(wanted, selected.sourceCommit, 'Tag targets another source.');
                }
                const refAfter = await ref();
                within();
                files.owner.assertSettled();
                assert.equal(owners.size, 0);
                complete = true;
                retained.delete(reader);
                return { refBefore, refAfter, objects };
            } catch (cause) {
                failed = true;
                throw new GatewayTagReadFailure(cause, reader);
            }
        },
    });
    return reader;
}
