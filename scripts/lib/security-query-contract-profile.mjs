import assert from 'node:assert/strict';
import path from 'node:path';
import { projectCollectorEnvironment } from './product-collector-environment.mjs';
import { firstCollectorSecurityQuery } from './pilot-security-command.mjs';

/** One existing green contract slot only. No filesystem/process/native-environment effects here.
 * Its fixture path/input stays unchanged; projected options do not attest effective environment equality. */
export function matchedOneDirectoryCommand({
    sourceRoot,
    nodeExecutable,
    powershell,
    environment,
    command,
}) {
    assert.equal(typeof command, 'function');
    assert.equal(typeof sourceRoot, 'string');
    assert.equal(typeof nodeExecutable, 'string');
    assert.equal(typeof powershell, 'string');
    const childPATH = path.dirname(nodeExecutable) + ';' + path.dirname(powershell);
    let used = false;
    return (source, exe, raw, options) => {
        assert(!used, 'Matched contract control already consumed');
        used = true;
        assert(source === sourceRoot && exe === powershell, 'Matched contract launch binding');
        assert(options.red === false, 'Matched contract green control only');
        const plans = JSON.parse(raw);
        assert(
            Array.isArray(plans) &&
                plans.length === 1 &&
                plans[0]?.kind === 'directory' &&
                typeof plans[0].path === 'string' &&
                Object.keys(plans[0]).sort().join(',') === 'kind,path',
            'Matched contract original one-directory input required',
        );
        const query = firstCollectorSecurityQuery({
            outputRoot: plans[0].path,
            diagnostic: true,
            command,
        });
        return query(source, exe, raw, {
            ...options,
            environment: projectCollectorEnvironment(environment, childPATH),
        });
    };
}
