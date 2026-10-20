// Pure projection shared with the production collector. Validation remains at each caller.
export const collectorEnvironmentKeys = Object.freeze([
    'GITHUB_RUN_ATTEMPT',
    'GITHUB_REPOSITORY',
    'GITHUB_SHA',
    'GITHUB_RUN_ID',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
    'COMSPEC',
    'ComSpec',
    'PATHEXT',
    'PSModulePath',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'ProgramData',
    'PUBLIC',
]);
export function projectCollectorEnvironment(environment, childPATH) {
    return {
        ...Object.fromEntries(
            collectorEnvironmentKeys
                .filter((key) => environment[key] !== undefined)
                .map((key) => [key, environment[key]]),
        ),
        PATH: childPATH,
    };
}
