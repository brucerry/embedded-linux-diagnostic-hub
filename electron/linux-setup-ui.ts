import path from 'node:path';
import { createHash } from 'node:crypto';
import semver from 'semver';
const { valid } = semver;
import { installationActions } from '../shared/installation.ts';
import type { LinuxReviewHost, reviewLinuxAppDir } from './linux-setup-review';
import { installedLinuxDesktopName } from './linux-window-identity.ts';
export type LinuxReviewSnapshot = Awaited<ReturnType<typeof reviewLinuxAppDir>>;
export interface LinuxReviewChoices {
    root: string;
    menu: boolean;
    menuExplicit?: boolean;
    terminal: boolean;
    version: string;
    operation: 'review' | 'install' | 'repair' | 'update' | 'launch' | 'rollback';
}
export interface LinuxPromptRequest {
    detail: string;
    menu: boolean;
    deadlineMs: number;
}
export type LinuxPromptReply =
    { status: 'confirmed'; menu: boolean } | { status: 'cancelled' | 'unavailable' | 'unknown' };
export interface LinuxPromptPort {
    review(request: LinuxPromptRequest): Promise<LinuxPromptReply>;
    hasPending(): boolean;
}
export interface LinuxReviewPorts {
    inspect(root: string): Promise<LinuxReviewSnapshot>;
    gui: LinuxPromptPort;
    terminal: LinuxPromptPort;
    now(): number;
    newId(): string;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const absolute = (value: string) =>
    typeof value === 'string' &&
    value.length <= 240 &&
    value.startsWith('/') &&
    path.posix.normalize(value) === value &&
    !/[\\\x00-\x1f\x7f]/.test(value);
const inside = (root: string, value: string) => value === root || value.startsWith(root + '/');
/** Local source-review CLI only. Legacy public downloader options keep their separate portable meaning. */
export function linuxReviewArguments(args: string[]): LinuxReviewChoices {
    const result: LinuxReviewChoices = {
        root: '',
        menu: false,
        menuExplicit: false,
        terminal: false,
        version: '',
        operation: 'review',
    };
    const seen = new Set<string>();
    for (let at = 0; at < args.length; at++) {
        const name = args[at],
            key = name === '--no-menu' ? '--menu' : name;
        if (seen.has(key)) throw Error('LINUX_REVIEW_ARGUMENT');
        seen.add(key);
        if (['--install-directory', '--version', '--operation'].includes(name)) {
            const value = args[++at];
            if (!value || value.startsWith('--')) throw Error('LINUX_REVIEW_ARGUMENT');
            if (name === '--install-directory') result.root = value;
            else if (name === '--version') result.version = value.replace(/^v/, '');
            else result.operation = value as LinuxReviewChoices['operation'];
        } else if (name === '--menu' || name === '--no-menu') {
            result.menu = name === '--menu';
            result.menuExplicit = true;
        }
        else if (name === '--terminal') result.terminal = true;
        else if (name !== '--no-launch') throw Error('LINUX_REVIEW_ARGUMENT');
    }
    if (
        !absolute(result.root) ||
        !result.version ||
        valid(result.version) !== result.version ||
        !['review', 'install', 'repair', 'update', 'launch', 'rollback'].includes(result.operation)
    )
        throw Error('LINUX_REVIEW_ARGUMENT');
    return result;
}
/** First escape an Exec quoted token, then desktop-value escapes. No decoded root enters shell code. */
const desktopToken = (value: string) =>
    ('"' + value.replace(/[\\"`$]/g, (char) => '\\' + char) + '"').replaceAll('\\', '\\\\');
export interface LinuxMenuPlan {
    path: string;
    bytes: string;
    sha256: string;
    installationId: string;
    root: string;
    uid: number;
    desktopName: string;
    requiredTools: string[];
    publicationAvailable: false;
}
export function linuxMenuPlan(
    host: LinuxReviewHost,
    root: string,
    installationId: string,
    dataHome: string,
): LinuxMenuPlan {
    host = clone(host);
    if (
        host.platform !== 'linux' ||
        host.arch !== 'x64' ||
        !Number.isSafeInteger(host.uid) ||
        host.uid <= 0 ||
        host.euid !== host.uid ||
        !uuid.test(installationId) ||
        ![host.home, root, dataHome].every(absolute) ||
        root === host.home ||
        dataHome === host.home ||
        !inside(host.home, root) ||
        !inside(host.home, dataHome) ||
        inside(root, dataHome) ||
        inside(dataHome, root)
    )
        throw Error('LINUX_MENU_LOCATION');
    const desktopName = installedLinuxDesktopName(installationId);
    const shell = 'r="$(/usr/bin/base64 --decode <<< "$1")" || exit 1; exec "$r/app/AppRun"';
    const encodedRoot = Buffer.from(root).toString('base64');
    const bytes =
        '[Desktop Entry]\nVersion=1.0\nType=Application\nName=Diagnostic Hub (' +
        installationId.slice(0, 8) +
        ')\n' +
        'Exec=/bin/bash -c ' +
        desktopToken(shell) +
        ' -- ' +
        encodedRoot +
        '\n' +
        'Terminal=false\nStartupWMClass=' +
        desktopName.replace(/\.desktop$/, '') +
        '\nCategories=Development;\n' +
        'X-DiagnosticHub-InstallationId=' +
        installationId +
        '\n';
    if (Buffer.byteLength(bytes) > 8192) throw Error('LINUX_MENU_BOUND');
    return {
        path: path.posix.join(dataHome, 'applications', desktopName),
        bytes,
        sha256: digest(bytes),
        installationId,
        root,
        uid: host.uid,
        desktopName,
        requiredTools: ['/bin/bash', '/usr/bin/base64'],
        publicationAvailable: false,
    };
}
/** Ownership is a prerequisite, never inferred from an empty folder or matching bytes alone. No effects. */
export function linuxMenuDecision(
    plan: LinuxMenuPlan,
    selected: boolean,
    current: { sha256: string; uid: number } | null,
    recorded: {
        path: string;
        sha256: string;
        root: string;
        uid: number;
        installationId: string;
    } | null,
) {
    if (typeof selected !== 'boolean') throw Error('LINUX_MENU_CHOICE');
    if (current === null)
        return { proposed: selected ? 'create' : 'retain-absent', executable: false as const };
    if (
        !current ||
        !recorded ||
        recorded.path !== plan.path ||
        recorded.root !== plan.root ||
        recorded.uid !== plan.uid ||
        current.uid !== plan.uid ||
        recorded.installationId !== plan.installationId ||
        !/^[a-f0-9]{64}$/.test(recorded.sha256) ||
        recorded.sha256 !== current.sha256
    )
        return { proposed: 'retain-foreign', executable: false as const };
    return {
        proposed: selected
            ? current.sha256 === plan.sha256
                ? 'unchanged'
                : 'replace-owned-after-review'
            : 'remove-owned-after-review',
        executable: false as const,
    };
}
function checkedReview(value: LinuxReviewSnapshot, host: LinuxReviewHost, root: string) {
    const review = clone(value);
    if (
        !review ||
        Buffer.byteLength(JSON.stringify(review)) > 8192 ||
        review.root !== root ||
        !['new', 'owned'].includes(review.state) ||
        review.qualification !== 'source-review-only' ||
        review.candidateVersion !== host.version ||
        !Array.isArray(review.actions) ||
        review.actions.length !== 0 ||
        !/^[a-f0-9]{64}$/.test(review.reviewToken) ||
        !Array.isArray(review.proposedActions) ||
        JSON.stringify(review.proposedActions) !==
            JSON.stringify(installationActions(review.installedVersion, review.candidateVersion))
    )
        throw Error('LINUX_REVIEW_SNAPSHOT');
    return review;
}
/** Actual frontend controller. There is deliberately no mutation/launch/native-backend capability. */
export async function runLinuxGuidedReview(
    hostInput: LinuxReviewHost,
    choicesInput: LinuxReviewChoices,
    dataHome: string,
    ports: LinuxReviewPorts,
) {
    const host = clone(hostInput),
        choices = clone(choicesInput),
        started = ports.now(),
        deadlineMs = started + 120000;
    const base = {
        mutationApproved: false as const,
        installed: false as const,
        launched: false as const,
        menuWritten: false as const,
    };
    const gate = () => {
        const now = ports.now();
        if (!Number.isFinite(now) || now < started || now >= deadlineMs)
            throw Error('LINUX_REVIEW_DEADLINE');
    };
    let phase = 'admission';
    try {
        if (
            !Number.isFinite(started) ||
            host.platform !== 'linux' ||
            host.arch !== 'x64' ||
            !Number.isSafeInteger(host.uid) ||
            host.uid <= 0 ||
            host.uid !== host.euid ||
            !absolute(choices.root) ||
            choices.version !== host.version ||
            typeof choices.menu !== 'boolean' ||
            (Object.hasOwn(choices, 'menuExplicit') && typeof choices.menuExplicit !== 'boolean') ||
            typeof choices.terminal !== 'boolean'
        )
            throw Error('LINUX_REVIEW_ADMISSION');
        gate();
        phase = 'source-review';
        const review = checkedReview(await ports.inspect(choices.root), host, choices.root);
        gate();
        if (
            choices.operation !== 'review' &&
            !review.proposedActions.some((action) => action === choices.operation)
        )
            return { ...base, status: 'unavailable', reason: 'ACTION_UNAVAILABLE' };
        const installationId =
            review.state === 'owned' ? path.posix.basename(review.profile) : ports.newId();
        if (
            !uuid.test(installationId) ||
            (review.state === 'owned' &&
                review.profile !==
                    path.posix.join(host.appData, 'DiagnosticHub', 'profiles', installationId))
        )
            throw Error('LINUX_REVIEW_PROFILE');
        const menu = linuxMenuPlan(host, choices.root, installationId, dataHome);
        const profile = path.posix.join(host.appData, 'DiagnosticHub', 'profiles', installationId);
        const detail =
            'Linux x64 – Diagnostic Hub ' +
            host.version +
            '\nApp: ' +
            choices.root +
            '\nSettings/reports: ' +
            profile +
            '\nExisting version: ' +
            (review.installedVersion ?? 'none') +
            '\nProposed choices: ' +
            review.proposedActions.join(', ') +
            '\nMenu entry: ' +
            menu.path +
            '\n\nReview only: installation, launch and menu changes are unavailable in this build. Existing files and reports remain unchanged. Cancel to choose another location with --install-directory.';
        phase = 'prompt';
        const request = { detail, menu: choices.menuExplicit === false ? review.options.startMenu : choices.menu, deadlineMs };
        let reply = clone(
            await (choices.terminal ? ports.terminal : ports.gui).review(clone(request)),
        );
        gate();
        if (reply.status === 'unavailable' && !choices.terminal) {
            reply = clone(await ports.terminal.review(clone(request)));
            gate();
        }
        if (reply.status === 'cancelled')
            return { ...base, status: 'cancelled', reason: 'REVIEW_CANCELLED' };
        if (reply.status === 'unavailable')
            return { ...base, status: 'unavailable', reason: 'NO_REVIEW_SURFACE' };
        if (reply.status !== 'confirmed' || typeof reply.menu !== 'boolean')
            return { ...base, status: 'unknown', reason: 'PROMPT_UNSETTLED' };
        phase = 'fresh-review';
        const fresh = checkedReview(await ports.inspect(choices.root), host, choices.root);
        gate();
        if (
            fresh.reviewToken !== review.reviewToken ||
            fresh.state !== review.state ||
            fresh.profile !== review.profile ||
            fresh.installedVersion !== review.installedVersion ||
            fresh.candidateVersion !== review.candidateVersion ||
            JSON.stringify(fresh.proposedActions) !== JSON.stringify(review.proposedActions)
        )
            return { ...base, status: 'refused', reason: 'REVIEW_CHANGED' };
        return {
            ...base,
            status: 'review-only',
            reason: 'LINUX_MUTATION_UNQUALIFIED',
            root: choices.root,
            profile,
            installationId,
            menuSelected: reply.menu,
            menuChoice: { dataHome, selected: reply.menu },
            menuPlan: reply.menu ? menu : null,
            actions: [] as string[],
        };
    } catch {
        return {
            ...base,
            status: phase === 'prompt' ? 'unknown' : 'refused',
            reason: 'REVIEW_REFUSED_OR_LATE',
        };
    }
}

/** Output failure cannot skip retained prompt custody. No stdout error is evidence of closure. */
export async function finishLinuxReview(
    result: { status: string },
    owner: { write(text: string): void; hasPending(): boolean; hold(): Promise<never> },
) {
    let published = false;
    try {
        const text = JSON.stringify(result) + '\n';
        if (Buffer.byteLength(text) > 8192) throw Error('LINUX_REVIEW_RESULT_BOUND');
        owner.write(text);
        published = true;
    } catch {
        /* fixed nonpass below, retaining the prompt owner */
    }
    if (owner.hasPending()) return owner.hold();
    return published && (result.status === 'review-only' || result.status === 'cancelled') ? 0 : 78;
}
