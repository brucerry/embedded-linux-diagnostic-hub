import { ADAPTERS, matches, PARAMETER_RANGES, UART_BAUDS } from '../../../shared/testing/profile';
import type { BoardProfile, Inventory } from '../../../shared/testing/types';
import { number, text } from '../../../shared/testing/validation';

export function profileFieldErrors(profile: BoardProfile | null, inventory: Inventory | null) {
    const errors: Record<string, string> = {};
    if (!profile) return errors;
    function check(key: string, operation: () => void) {
        try {
            operation();
        } catch (e) {
            errors[key] = e instanceof Error ? e.message : 'Invalid value.';
        }
    }
    check('name', () => text(profile.name, 'Profile name', 160, false));
    check('revision', () => text(profile.revision, 'Profile revision', 64, false));
    check('boardRevision', () => text(profile.boardRevision, 'Declared board revision', 128));
    check('match.model', () => text(profile.match.model, 'Model'));
    check('match.compatible', () => text(profile.match.compatible, 'Compatible identity'));
    if (!profile.match.model && !profile.match.compatible && !profile.match.manual) {
        errors['match.model'] =
            errors['match.compatible'] =
            errors['match.manual'] =
                'Enter a board identity or enable explicit manual mappings.';
    }
    if (inventory && profile.match.model && profile.match.model !== inventory.device.model)
        errors['match.model'] = 'Model does not match the discovered board.';
    if (
        inventory &&
        profile.match.compatible &&
        !inventory.device.compatible.includes(profile.match.compatible)
    )
        errors['match.compatible'] = 'Compatible identity does not match the discovered board.';
    for (const [i, test] of profile.tests.entries()) {
        const prefix = `tests.${i}.`;
        check(prefix + 'name', () => text(test.name, 'Test name', 160, false));
        check(prefix + 'fixture', () => text(test.fixture, 'Fixture requirement', 1024, false));
        check(prefix + 'expected', () => text(test.expected, 'Expected behavior', 1024, false));
        const mapping = profile.resources.find((r) => r.id === test.resource);
        if (!mapping || mapping.domain !== ADAPTERS[test.adapter].domain)
            errors[prefix + 'resource'] = 'Choose a compatible logical resource.';
        const candidates =
            mapping && Object.keys(mapping.selector).length
                ? (inventory?.resources.filter(
                      (r) => r.domain === mapping.domain && matches(r, mapping.selector),
                  ) ?? [])
                : [];
        if (candidates.length !== 1)
            errors[prefix + 'mapping'] = 'Map exactly one observed resource.';
        for (const [key, value] of Object.entries(test.parameters)) {
            check(prefix + 'parameters.' + key, () => {
                if (value === null) throw Error('A value is required.');
                if (key === 'payload') text(value, 'Payload', 4096, false);
                else number(value, key, ...PARAMETER_RANGES[key]);
                if (key === 'baud' && !UART_BAUDS.includes(value as number))
                    throw Error('Choose a supported baud rate.');
                if (
                    key === 'level' &&
                    candidates.length === 1 &&
                    /^\d+$/.test(candidates[0].metadata.maxBrightness ?? '') &&
                    Number(value) > Number(candidates[0].metadata.maxBrightness)
                )
                    throw Error(
                        `Brightness must not exceed ${candidates[0].metadata.maxBrightness}.`,
                    );
            });
        }
    }
    return errors;
}
