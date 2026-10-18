export const SETUP_ACTIONS = [
    {
        token: 'install',
        label: 'Install Diagnostic Hub',
        button: 'Install',
        effect: 'Create application files in the selected folder. Your settings and reports stay separate and are retained.',
    },
    {
        token: 'launch',
        label: 'Open Diagnostic Hub',
        button: 'Open',
        effect: 'Open this installed copy. Setup will not replace or remove application files.',
    },
    {
        token: 'update',
        label: 'Update application',
        button: 'Update',
        effect: 'Replace application files with this version. Keep the previous copy until the new app is confirmed. Retain settings and reports.',
    },
    {
        token: 'repair',
        label: 'Repair application',
        button: 'Repair',
        effect: "Restore this version's application files. Keep the previous copy until confirmation. Retain settings and reports.",
    },
    {
        token: 'finalize',
        label: 'Confirm update and remove old copy',
        button: 'Confirm',
        effect: 'Verify the running app, then remove the retained previous application copy. Your settings and reports are retained.',
    },
    {
        token: 'rollback',
        label: 'Recover previous state',
        button: 'Recover',
        effect: 'Restore the state before this setup attempt and remove failed or staged application files. Your settings and reports are retained.',
    },
    {
        token: 'finishremove',
        label: 'Continue application removal',
        button: 'Remove',
        effect: 'Finish removing this application, its owned shortcuts and uninstall entry. Your settings and reports are retained.',
    },
    {
        token: 'remove',
        label: 'Remove Diagnostic Hub',
        button: 'Remove',
        effect: 'Remove this application, its owned shortcuts and uninstall entry. Your settings and reports are retained.',
    },
] as const;

export function setupActionPresentation(token: string) {
    const action = SETUP_ACTIONS.find((action) => action.token === token);
    if (!action) throw Error('Unsupported setup action.');
    return action;
}
const quoted = (value: string) => {
    if (/[\x00-\x1f$]/.test(value)) throw Error('Unsafe setup presentation text.');
    return '"' + value.replaceAll('"', '$\\"') + '"';
};
/** The same catalog generates display, token resolution and final-action captions. */
export function renderSetupPresentationNSIS() {
    const add = SETUP_ACTIONS.map(
        (action) =>
            `  ReadINIStr $0 "$HubResponse" setup can${action.token}\n  \${If} $0 == "1"\n    \${NSD_CB_AddString} $HubActionBox ${quoted(action.label)}\n  \${EndIf}`,
    ).join('\n');
    const resolve = SETUP_ACTIONS.map(
        (action) =>
            `  \${If} $HubActionLabel == ${quoted(action.label)}\n    StrCpy $HubOperation ${quoted(action.token)}\n  \${EndIf}`,
    ).join('\n');
    const describe = SETUP_ACTIONS.map(
        (action) =>
            `  \${If} $HubOperation == ${quoted(action.token)}\n    StrCpy $HubActionLabel ${quoted(action.label)}\n    StrCpy $HubActionEffect ${quoted(action.effect)}\n    StrCpy $HubActionButton ${quoted(action.button)}\n  \${EndIf}`,
    ).join('\n');
    return `; Generated from shared/setup-presentation.ts. Do not edit this generated artifact.\n!macro HubAddActions\n${add}\n!macroend\n!macro HubResolveAction\n  StrCpy $HubOperation ""\n${resolve}\n!macroend\n!macro HubDescribeAction\n  StrCpy $HubActionLabel ""\n  StrCpy $HubActionEffect ""\n  StrCpy $HubActionButton ""\n${describe}\n!macroend\n`;
}
