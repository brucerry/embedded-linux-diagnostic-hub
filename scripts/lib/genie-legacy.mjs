// Build legacy modules from the owned modern source; never fork the effect or its math.
export function legacyExtension(source, adapter) {
    const marker = "const EFFECT_NAME = 'diagnostic-hub-genie';";
    if (
        source.split(marker).length !== 2 ||
        source.split('export default class DiagnosticHubGenie extends Extension').length !== 2 ||
        source.split('new TextDecoder().decode(bytes)').length !== 2
    ) {
        throw Error('Shared companion layout changed; review the legacy adapter.');
    }
    const body = source
        .slice(source.indexOf(marker))
        .replace('export default class DiagnosticHubGenie', 'class DiagnosticHubGenie')
        .replace('new TextDecoder().decode(bytes)', 'ByteArray.toString(bytes)');
    if (/^\s*(?:import|export)\s/m.test(body)) throw Error('Unexpected ESM in legacy effect.');
    return adapter + '\n' + body;
}

export function legacyGeometry(source) {
    const result = source
        .replace(/^export const /gm, 'var ')
        .replace(/^export function /gm, 'function ')
        .replace('var SHELL_MAJORS = [46, 48, 50];', 'var SHELL_MAJORS = [42];');
    if (!result.includes('var SHELL_MAJORS = [42];') || /^\s*(?:import|export)\s/m.test(result))
        throw Error('Shared geometry layout changed; review legacy exports.');
    return result;
}
