import path from 'node:path';
import { linuxMenuPlan } from './linux-setup-ui.ts';
import type { LinuxReviewHost } from './linux-setup-review';
import type { LinuxModelIdentity } from './linux-transaction-model';

export interface LinuxMenuChoice { dataHome: string; selected: boolean }
export interface LinuxMenuRecord {
    kind: 'linux-desktop'; path: string; root: string; installationId: string;
    uid: number; bytes: number; sha256: string;
}
export interface LinuxMenuFile { identity: LinuxModelIdentity; bytes: number; sha256: string }
export interface LinuxMenuView {
    current: LinuxMenuFile | null; candidate: LinuxMenuFile | null; previous: LinuxMenuFile | null;
}
export type LinuxMenuSlot = keyof LinuxMenuView;
export type LinuxMenuPhase = 'pending' | 'staged' | 'retained' | 'applied' |
    'rollback-pending' | 'rollback-candidate-retained' | 'restored';
export interface LinuxMenuJournal {
    action: 'create' | 'replace' | 'deselect' | 'drop-absent' | 'unchanged' | 'retain-foreign' | 'retain-absent';
    before: LinuxMenuRecord | null; after: LinuxMenuRecord | null;
    beforeFile: LinuxMenuFile | null; phase: LinuxMenuPhase;
}
export interface LinuxMenuContext {
    host: LinuxReviewHost; root: string; installationId: string; menu?: LinuxMenuChoice;
}
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));
export const sameLinuxMenu = (a: unknown, b: unknown): boolean => {
    const ordered = (v: unknown): unknown => Array.isArray(v) ? v.map(ordered) :
        v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, ordered(x)])) : v;
    return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
};
function fields(v: unknown, names: string[]): asserts v is Record<string, unknown> {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== names.length ||
        Object.keys(v).some((k) => !names.includes(k))) throw Error('LINUX_MENU_GRAMMAR');
}
const inside = (a: string, b: string) => b === a || b.startsWith(a + '/');
export function checkedLinuxMenuChoice(context: LinuxMenuContext): LinuxMenuChoice {
    const choice = copy(context.menu);
    fields(choice, ['dataHome', 'selected']);
    if (typeof choice.dataHome !== 'string' || typeof choice.selected !== 'boolean') throw Error('LINUX_MENU_CHOICE');
    linuxMenuPlan(context.host, context.root, context.installationId, choice.dataHome);
    for (const protectedRoot of [context.host.sourceRoot, context.host.appData])
        if (inside(protectedRoot, choice.dataHome) || inside(choice.dataHome, protectedRoot)) throw Error('LINUX_MENU_LOCATION');
    return choice as unknown as LinuxMenuChoice;
}
export function desiredLinuxMenu(context: LinuxMenuContext): { record: LinuxMenuRecord; text: string } {
    const choice = checkedLinuxMenuChoice(context);
    const plan = linuxMenuPlan(context.host, context.root, context.installationId, choice.dataHome);
    return { record: { kind: 'linux-desktop', path: plan.path, root: plan.root,
        installationId: plan.installationId, uid: plan.uid, bytes: Buffer.byteLength(plan.bytes), sha256: plan.sha256 }, text: plan.bytes };
}
export function checkedLinuxMenuRecord(input: unknown, context: LinuxMenuContext): LinuxMenuRecord {
    fields(input, ['kind', 'path', 'root', 'installationId', 'uid', 'bytes', 'sha256']);
    const record = copy(input) as unknown as LinuxMenuRecord;
    const expected = desiredLinuxMenu(context).record;
    if (record.kind !== 'linux-desktop' || record.path !== expected.path || record.root !== context.root ||
        record.installationId !== context.installationId || record.uid !== context.host.uid ||
        !Number.isSafeInteger(record.bytes) || record.bytes <= 0 || record.bytes > 8192 ||
        typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)) throw Error('LINUX_MENU_OWNERSHIP');
    return record;
}
export function checkedLinuxMenuFile(input: unknown, uid: number): LinuxMenuFile {
    fields(input, ['identity', 'bytes', 'sha256']);
    fields(input.identity, ['dev', 'ino', 'uid']);
    const file = copy(input) as unknown as LinuxMenuFile;
    if (!Number.isSafeInteger(file.identity.dev) || file.identity.dev < 0 ||
        !Number.isSafeInteger(file.identity.ino) || file.identity.ino <= 0 || file.identity.uid !== uid ||
        !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > 8192 ||
        typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw Error('LINUX_MENU_FILE');
    return file;
}
export function checkedLinuxMenuView(input: unknown, uid: number): LinuxMenuView {
    fields(input, ['current', 'candidate', 'previous']);
    const view = copy(input) as unknown as LinuxMenuView;
    const identities = new Set<string>();
    for (const slot of ['current', 'candidate', 'previous'] as const) if (view[slot] !== null) {
        const value = checkedLinuxMenuFile(view[slot], uid), key = value.identity.dev + ':' + value.identity.ino;
        if (identities.has(key)) throw Error('LINUX_MENU_ALIAS');
        identities.add(key);
    }
    return view;
}
export function prepareLinuxMenuJournal(context: LinuxMenuContext, beforeInput: LinuxMenuRecord | null,
    fileInput: LinuxMenuFile | null): LinuxMenuJournal {
    const choice = checkedLinuxMenuChoice(context);
    const before = beforeInput === null ? null : checkedLinuxMenuRecord(beforeInput, context);
    const beforeFile = fileInput === null ? null : checkedLinuxMenuFile(fileInput, context.host.uid);
    const desired = desiredLinuxMenu(context).record;
    if (before && beforeFile && (before.sha256 !== beforeFile.sha256 || before.bytes !== beforeFile.bytes))
        throw Error('LINUX_MENU_FOREIGN_OR_EDITED');
    if (!before && beforeFile && choice.selected) throw Error('LINUX_MENU_FOREIGN_OR_EDITED');
    const after = choice.selected ? desired : null;
    const action = choice.selected ? !beforeFile ? 'create' : sameLinuxMenu(before, after) ? 'unchanged' : 'replace' :
        before ? beforeFile ? 'deselect' : 'drop-absent' : beforeFile ? 'retain-foreign' : 'retain-absent';
    return { action, before, after, beforeFile, phase: 'pending' };
}
export function checkedLinuxMenuJournal(input: unknown, context: LinuxMenuContext): LinuxMenuJournal {
    fields(input, ['action', 'before', 'after', 'beforeFile', 'phase']);
    const value = copy(input) as unknown as LinuxMenuJournal;
    const expected = prepareLinuxMenuJournal(context, value.before, value.beforeFile);
    if (!sameLinuxMenu({ ...value, phase: 'pending' }, expected) ||
        !['pending', 'staged', 'retained', 'applied', 'rollback-pending', 'rollback-candidate-retained', 'restored'].includes(value.phase))
        throw Error('LINUX_MENU_JOURNAL');
    return value;
}
export function assertLinuxMenuAdvance(before: LinuxMenuJournal, after: LinuxMenuJournal) {
    const next: Record<LinuxMenuPhase, LinuxMenuPhase[]> = {
        pending: ['staged', 'retained', 'applied'], staged: ['retained', 'applied'], retained: ['applied'],
        applied: ['rollback-pending'], 'rollback-pending': ['rollback-candidate-retained'],
        'rollback-candidate-retained': ['restored'], restored: [],
    };
    if (!sameLinuxMenu({ ...before, phase: after.phase }, after) || !next[before.phase]?.includes(after.phase))
        throw Error('LINUX_MENU_JOURNAL_TRANSITION');
}
/** Fixed paths only; no directory search, file open, native import or mutation here. */
export function linuxMenuPaths(context: LinuxMenuContext, work: string) {
    return { current: desiredLinuxMenu(context).record.path,
        candidate: path.posix.join(work, 'menu-candidate.desktop'), previous: path.posix.join(work, 'menu-previous.desktop') };
}

/** A journal acknowledgement cannot claim a phase whose exact file-slot effects are absent. */
export function assertLinuxMenuPhase(viewInput: LinuxMenuView, journalInput: LinuxMenuJournal,
    context: LinuxMenuContext) {
    const view = checkedLinuxMenuView(viewInput, context.host.uid);
    const journal = checkedLinuxMenuJournal(journalInput, context);
    const written = journal.action === 'create' || journal.action === 'replace';
    const retained = journal.action === 'replace' || journal.action === 'deselect';
    const content = (value: LinuxMenuFile | null) => value !== null && journal.after !== null &&
        value.bytes === journal.after.bytes && value.sha256 === journal.after.sha256;
    const exact = (a: LinuxMenuFile | null, b: LinuxMenuFile | null) => sameLinuxMenu(a, b);
    let valid = false;
    if (journal.phase === 'pending') valid = exact(view.current, journal.beforeFile) && view.candidate === null && view.previous === null;
    if (journal.phase === 'staged') valid = written && exact(view.current, journal.beforeFile) && content(view.candidate) && view.previous === null;
    if (journal.phase === 'retained') valid = retained && view.current === null && journal.beforeFile !== null && exact(view.previous, journal.beforeFile) && (written ? content(view.candidate) : view.candidate === null);
    if (journal.phase === 'applied' || journal.phase === 'rollback-pending') valid =
        (written ? content(view.current) : exact(view.current, journal.action === 'deselect' ? null : journal.beforeFile)) &&
        view.candidate === null && (retained ? journal.beforeFile !== null && exact(view.previous, journal.beforeFile) : view.previous === null);
    if (journal.phase === 'rollback-candidate-retained') valid =
        (written ? view.current === null && content(view.candidate) : view.candidate === null && exact(view.current, journal.action === 'deselect' ? null : journal.beforeFile)) &&
        (retained ? journal.beforeFile !== null && exact(view.previous, journal.beforeFile) : view.previous === null);
    if (journal.phase === 'restored') valid = exact(view.current, journal.beforeFile) && view.previous === null && (written ? content(view.candidate) : view.candidate === null);
    if (!valid) throw Error('LINUX_MENU_PHASE_FILES_DIFFER');
}
