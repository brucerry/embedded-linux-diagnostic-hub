import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
    linuxReviewArguments,
    linuxMenuPlan,
    linuxMenuDecision,
    runLinuxGuidedReview,
    finishLinuxReview,
    type LinuxReviewPorts,
    type LinuxReviewSnapshot,
} from '../electron/linux-setup-ui.ts';
import {
    installedLinuxDesktopName,
    withInstalledLinuxWindow,
    withNativeLinuxWindow,
} from '../electron/linux-window-identity.ts';
const id = '11111111-1111-4111-8111-111111111111';
const host = {
    platform: 'linux',
    arch: 'x64',
    uid: 1000,
    euid: 1000,
    home: '/home/test',
    appData: '/home/test/config',
    sourceRoot: '/home/test/source',
    version: '0.6.0',
};
const dataHome = '/home/test/data',
    root = '/home/test/installed';
const choices = () =>
    linuxReviewArguments(['--install-directory', root, '--version', 'v0.6.0', '--menu']);
function fixture(owned = false) {
    let now = 0,
        inspections = 0,
        gui = 0,
        tty = 0;
    const review: LinuxReviewSnapshot = {
        root,
        state: owned ? 'owned' : 'new',
        installedVersion: owned ? '0.5.2' : null,
        candidateVersion: host.version,
        actions: [],
        proposedActions: owned ? ['launch', 'update'] : ['install'],
        profile: host.appData + '/DiagnosticHub/profiles/' + (owned ? id : '(new installation)'),
        reviewToken: 'a'.repeat(64),
        options: { startMenu: false, desktop: false, launch: false },
        needsRepair: false,
        qualification: 'source-review-only',
        message: 'source review',
    };
    const ports: LinuxReviewPorts = {
        inspect: async () => {
            inspections++;
            return JSON.parse(JSON.stringify(review));
        },
        now: () => now,
        newId: () => id,
        gui: {
            review: async () => {
                gui++;
                return { status: 'confirmed', menu: true };
            },
            hasPending: () => false,
        },
        terminal: {
            review: async () => {
                tty++;
                return { status: 'confirmed', menu: false };
            },
            hasPending: () => false,
        },
    };
    return {
        review,
        ports,
        setNow(value: number) {
            now = value;
        },
        counts: () => ({ inspections, gui, tty }),
    };
}
test('new GUI review uses validated source/location and returns no mutation, launch or menu write authority', async () => {
    const f = fixture(),
        result = await runLinuxGuidedReview(host, choices(), dataHome, f.ports);
    assert.equal(result.status, 'review-only');
    assert.ok('installationId' in result);
    assert.equal(result.mutationApproved, false);
    assert.equal(result.installed, false);
    assert.equal(result.launched, false);
    assert.equal(result.menuWritten, false);
    assert.deepEqual(f.counts(), { inspections: 2, gui: 1, tty: 0 });
    assert.equal(result.installationId, id);
    assert.equal(result.profile, host.appData + '/DiagnosticHub/profiles/' + id);
    assert.equal(result.menuPlan?.publicationAvailable, false);
    assert.deepEqual(result.actions, []);
});
test('existing installation keeps exact UUID/profile and no downgrade or separate shared profile', async () => {
    const f = fixture(true),
        result = await runLinuxGuidedReview(host, choices(), dataHome, f.ports);
    assert.equal(result.status, 'review-only');
    assert.ok('installationId' in result);
    assert.equal(result.installationId, id);
    assert.equal(result.profile, f.review.profile);
    f.review.installedVersion = '0.7.0';
    f.review.proposedActions = ['launch'];
    const request = { ...choices(), operation: 'update' as const };
    assert.equal(
        (await runLinuxGuidedReview(host, request, dataHome, f.ports)).status,
        'unavailable',
    );
});
test('explicit terminal mode never probes GUI; no GUI surface falls back once only to controlling terminal', async () => {
    const f = fixture();
    assert.equal(
        (await runLinuxGuidedReview(host, { ...choices(), terminal: true }, dataHome, f.ports))
            .status,
        'review-only',
    );
    assert.equal(f.counts().gui, 0);
    assert.equal(f.counts().tty, 1);
    const g = fixture();
    g.ports.gui.review = async () => ({ status: 'unavailable' });
    const result = await runLinuxGuidedReview(host, choices(), dataHome, g.ports);
    assert.equal(result.status, 'review-only');
    assert.ok('installationId' in result);
    assert.equal(result.menuSelected, false);
    assert.equal(g.counts().tty, 1);
});
for (const status of ['cancelled', 'unknown'] as const)
    test('GUI ' + status + ' never retries or falls back to TTY', async () => {
        const f = fixture();
        f.ports.gui.review = async () => ({ status });
        assert.equal(
            (await runLinuxGuidedReview(host, choices(), dataHome, f.ports)).status,
            status,
        );
        assert.equal(f.counts().inspections, 1);
        assert.equal(f.counts().tty, 0);
    });
test('no review surface refuses without silently accepting input or copying files', async () => {
    const f = fixture();
    f.ports.gui.review = f.ports.terminal.review = async () => ({ status: 'unavailable' });
    const result = await runLinuxGuidedReview(host, choices(), dataHome, f.ports);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.mutationApproved, false);
});
for (const delta of [
    { platform: 'darwin' },
    { platform: 'win32' },
    { arch: 'arm64' },
    { uid: 0 },
    { euid: 0 },
])
    test(
        'unsupported ordinary-user host refuses before source/prompt: ' + JSON.stringify(delta),
        async () => {
            const f = fixture();
            assert.equal(
                (await runLinuxGuidedReview({ ...host, ...delta }, choices(), dataHome, f.ports))
                    .status,
                'refused',
            );
            assert.deepEqual(f.counts(), { inspections: 0, gui: 0, tty: 0 });
        },
    );
test('changed source token, forged operational actions and invalid profile cannot be confirmed', async () => {
    const f = fixture();
    f.ports.gui.review = async () => {
        f.review.reviewToken = 'b'.repeat(64);
        return { status: 'confirmed', menu: true };
    };
    assert.equal(
        (await runLinuxGuidedReview(host, choices(), dataHome, f.ports)).status,
        'refused',
    );
    const g = fixture();
    g.review.actions = ['install'];
    assert.equal(
        (await runLinuxGuidedReview(host, choices(), dataHome, g.ports)).status,
        'refused',
    );
    assert.equal(g.counts().gui, 0);
    const h = fixture(true);
    h.review.profile = '/foreign/profile';
    assert.equal(
        (await runLinuxGuidedReview(host, choices(), dataHome, h.ports)).status,
        'refused',
    );
    assert.equal(h.counts().gui, 0);
});
test('prompt-return mutation, malformed ack and deadline cannot forge an operational grant', async () => {
    const f = fixture();
    f.ports.gui.review = async (request) => {
        request.detail = 'private-canary';
        request.deadlineMs = Infinity;
        f.setNow(120000);
        return { status: 'confirmed', menu: true };
    };
    const result = await runLinuxGuidedReview(host, choices(), dataHome, f.ports);
    assert.equal(result.status, 'unknown');
    assert.equal(result.mutationApproved, false);
    assert.equal(f.counts().inspections, 1);
    assert.doesNotMatch(JSON.stringify(result), /canary/);
    const g = fixture();
    g.ports.gui.review = async () => ({ status: 'confirmed', menu: 'yes' as unknown as boolean });
    assert.equal(
        (await runLinuxGuidedReview(host, choices(), dataHome, g.ports)).status,
        'unknown',
    );
});
test('CLI argument contract distinguishes installation location from legacy download cache/format and has no unattended accept', () => {
    const parsed = linuxReviewArguments([
        '--version',
        '0.6.0',
        '--install-directory',
        root,
        '--terminal',
        '--no-menu',
        '--no-launch',
        '--operation',
        'repair',
    ]);
    assert.equal(parsed.root, root);
    assert.equal(parsed.menu, false);
    assert.equal(parsed.terminal, true);
    assert.equal(parsed.operation, 'repair');
    for (const extra of [
        ['--directory', root],
        ['--format', 'tar.gz'],
        ['--yes'],
        ['--menu', '--no-menu'],
        ['--operation', 'remove'],
        ['--install-directory', '../outside'],
        ['--version', 'bad'],
    ])
        assert.throws(() =>
            linuxReviewArguments(['--version', '0.6.0', '--install-directory', root, ...extra]),
        );
});
function desktopDecode(text: string) {
    return text.replace(
        /\\([\\ntrs])/g,
        (_whole, code: string) => ({ '\\': '\\', n: '\n', t: '\t', r: '\r', s: ' ' })[code]!,
    );
}
function execTokens(value: string) {
    const tokens: string[] = [];
    let token = '',
        quote = false;
    for (let at = 0; at < value.length; at++) {
        const char = value[at];
        if (char === '\\') {
            token += value[++at];
            continue;
        }
        if (char === '"') {
            quote = !quote;
            continue;
        }
        if (char === ' ' && !quote) {
            if (token) {
                tokens.push(token);
                token = '';
            }
            continue;
        }
        token += char;
    }
    assert.equal(quote, false);
    if (token) tokens.push(token);
    return tokens;
}
test('menu plan preserves literal Unicode/quotes/percent/dollar paths as base64 data and fixed shell program', () => {
    const location = '/home/test/App 茶 "quote" %f $x `x`',
        plan = linuxMenuPlan(host, location, id, dataHome);
    assert.equal(plan.publicationAvailable, false);
    assert.equal(plan.path, dataHome + '/applications/diagnostic-hub-' + id + '.desktop');
    const exec = plan.bytes
            .split('\n')
            .find((line) => line.startsWith('Exec='))!
            .slice(5),
        tokens = execTokens(desktopDecode(exec));
    assert.deepEqual(tokens.slice(0, 2), ['/bin/bash', '-c']);
    assert.equal(tokens[3], '--');
    assert.equal(tokens.length, 5);
    assert.equal(Buffer.from(tokens[4], 'base64').toString(), location);
    assert.equal(
        tokens[2],
        'r="$(/usr/bin/base64 --decode <<< "$1")" || exit 1; exec "$r/app/AppRun"',
    );
    assert.equal(exec.includes(location), false);
    assert.equal(exec.includes('%'), false);
    assert.match(plan.bytes, /StartupWMClass=diagnostic-hub-11111111-/);
    assert.equal(createHash('sha256').update(plan.bytes).digest('hex'), plan.sha256);
});
test('foreign menu or changed owned bytes are retained; matching bytes alone do not grant authority', () => {
    const plan = linuxMenuPlan(host, root, id, dataHome),
        record = { path: plan.path, sha256: plan.sha256, root, uid: 1000, installationId: id };
    assert.equal(linuxMenuDecision(plan, true, null, null).proposed, 'create');
    assert.equal(
        linuxMenuDecision(plan, true, { uid: 1000, sha256: plan.sha256 }, null).proposed,
        'retain-foreign',
    );
    assert.equal(
        linuxMenuDecision(plan, false, { uid: 1000, sha256: '0'.repeat(64) }, record).proposed,
        'retain-foreign',
    );
    assert.equal(
        linuxMenuDecision(plan, true, { uid: 1000, sha256: plan.sha256 }, record).proposed,
        'unchanged',
    );
    const deselect = linuxMenuDecision(plan, false, { uid: 1000, sha256: plan.sha256 }, record);
    assert.equal(deselect.proposed, 'remove-owned-after-review');
    assert.equal(deselect.executable, false);
});
test('menu location/platform/root overlap refuses without writing or changing permissions', () => {
    for (const data of [
        '/outside',
        '/home/test/installed/data',
        '/home/test',
        '/home/test/../alias',
    ])
        assert.throws(() => linuxMenuPlan(host, root, id, data));
    assert.throws(() => linuxMenuPlan({ ...host, uid: 0, euid: 0 }, root, id, dataHome));
    assert.throws(() => linuxMenuPlan(host, root, 'bad', dataHome));
});
test('installed window identity matches menu UUID and restores legacy identity even on failure', () => {
    let current = 'diagnostic-hub.desktop';
    const set = (value: string) => {
        current = value;
    };
    assert.equal(
        withInstalledLinuxWindow(set, id, () => current),
        installedLinuxDesktopName(id),
    );
    assert.equal(current, 'diagnostic-hub.desktop');
    assert.throws(() =>
        withInstalledLinuxWindow(set, id, () => {
            throw Error('inert window failure');
        }),
    );
    assert.equal(current, 'diagnostic-hub.desktop');
    assert.throws(() => withInstalledLinuxWindow(set, 'bad', () => {}));
    assert.equal(current, 'diagnostic-hub.desktop');
    assert.equal(
        withNativeLinuxWindow(set, () => current),
        'diagnostic-hub-native.desktop',
    );
    assert.equal(current, 'diagnostic-hub.desktop');
});
test('actual public helper gates new permanent intent before native inspection/download, preserving legacy portable code', () => {
    const source = readFileSync(new URL('../public/download-run.sh', import.meta.url), 'utf8');
    const start = source.indexOf('if [[ $permanent_choice == 1 ]]'),
        firstHost = source.indexOf('[[ $(uname -s)'),
        firstNetwork = source.indexOf('curl ');
    assert.ok(start > 0 && firstHost > start && firstNetwork > start);
    assert.match(source.slice(start, firstHost), /fail 'Permanent AppDir setup is not qualified/);
    assert.match(source, /--portable\) portable_choice=1/);
    assert.match(source, /--directory\) directory=\$2; portable_choice=1/);
    assert.match(source, /--download-only\) download_only=1; portable_choice=1/);
    assert.match(source, /sha256sum --check --status/);
    assert.doesNotMatch(source, /Genie|gnome-extensions|gsettings/);
});
test('actual source entrypoints are gated/read-only and installed launcher cannot add system integrations', () => {
    const cli = readFileSync(new URL('../scripts/linux-setup-review.cts', import.meta.url), 'utf8'),
        launcher = readFileSync(
            new URL('../scripts/linux-installed-launcher.sh', import.meta.url),
            'utf8',
        );
    assert.match(cli, /require\.main === module/);
    assert.match(cli, /process\.versions\.electron/);
    assert.match(cli, /ELECTRON_RUN_AS_NODE/);
    assert.doesNotMatch(
        cli,
        /createLinuxNativeBackend|checkedLinuxRenameBinding|spawn\(|execFile|\.install\(/,
    );
    assert.match(launcher, /unset ELECTRON_RUN_AS_NODE NODE_OPTIONS NODE_PATH APPIMAGE APPDIR/);
    assert.match(launcher, /exec "\$runtime\/diagnostic-hub" "\$@"/);
    assert.doesNotMatch(launcher, /\b(?:sudo|apt-get|chmod|rm|kill|gsettings)\b|--no-sandbox/);
});

test('confirmed prompt flags and fresh profile cannot change through shared references during readback', async () => {
    const f = fixture();
    const reply = { status: 'confirmed' as const, menu: false };
    f.ports.gui.review = async () => reply;
    let calls = 0;
    const original = f.ports.inspect;
    f.ports.inspect = async (root) => {
        if (++calls === 2) reply.menu = true;
        return original(root);
    };
    const result = await runLinuxGuidedReview(host, choices(), dataHome, f.ports);
    assert.equal(result.status, 'review-only');
    assert.ok('installationId' in result);
    assert.equal(result.menuSelected, false);
    const g = fixture(true);
    let reads = 0;
    const inspect = g.ports.inspect;
    g.ports.inspect = async (root) => {
        const value = await inspect(root);
        if (++reads === 2) value.profile = '/foreign/profile';
        return value;
    };
    assert.equal(
        (await runLinuxGuidedReview(host, choices(), dataHome, g.ports)).status,
        'refused',
    );
});
test('bounded output failures cannot bypass pending prompt ownership', async () => {
    const held = Error('inert-held-owner');
    let park = 0,
        writes = 0;
    await assert.rejects(
        finishLinuxReview(
            { status: 'unknown' },
            {
                write() {
                    writes++;
                    throw Error('private-output-canary');
                },
                hasPending: () => true,
                hold: async () => {
                    park++;
                    throw held;
                },
            },
        ),
        (error) => error === held,
    );
    assert.equal(park, 1);
    assert.equal(writes, 1);
    assert.equal(
        await finishLinuxReview(
            { status: 'review-only' },
            {
                write() {
                    throw Error('private');
                },
                hasPending: () => false,
                hold: async () => {
                    throw held;
                },
            },
        ),
        78,
    );
    assert.equal(
        await finishLinuxReview(
            { status: 'review-only' },
            {
                write() {},
                hasPending: () => false,
                hold: async () => {
                    throw held;
                },
            },
        ),
        0,
    );
});
