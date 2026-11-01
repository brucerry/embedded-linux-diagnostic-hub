import type { SerialState } from './session';

/** Only this Serial owner's recovery may bypass the Automation busy presentation. */
export function serialUiAdmission(guards: {
    automationBusy: boolean;
    resetting: boolean;
    showConnect: boolean;
    showUpdates: boolean;
    selectedProbe: boolean;
}) {
    const disconnectBlocked =
        guards.resetting || guards.showConnect || guards.showUpdates || guards.selectedProbe;
    return { blocked: guards.automationBusy || disconnectBlocked, disconnectBlocked };
}

export function serialCanDisconnect(
    state: SerialState,
    blocked: boolean,
    disconnectBlocked: boolean,
    quarantined: boolean,
) {
    return (
        ['opening', 'connected', 'error'].includes(state) &&
        (!blocked || (quarantined && !disconnectBlocked))
    );
}
