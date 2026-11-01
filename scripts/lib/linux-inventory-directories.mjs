/**
 * Admission only: expectedDirectories must come from planLinuxReviewEnvelope.
 * Call after retained metadata admission and planning, before creating any stream.
 * This does not authenticate the directory table or enable empty-directory layouts.
 */
export function assertLinuxInventoryDirectories(expectedDirectories, retainedDirectories) {
    const validate = value => {
        if (!Array.isArray(value) || value.length > 20000)
            throw Error('LINUX_DIRECTORY_INVENTORY');
        const seen = new Set();
        const directories = [];
        for (const name of value) {
            if (typeof name !== 'string' || !name || name.length > 1024 ||
                /[\\\x00-\x1f\x7f]/.test(name) || name.startsWith('/') ||
                /^[a-z]:/i.test(name) ||
                name.split('/').some(part => !part || part === '.' || part === '..'))
                throw Error('LINUX_DIRECTORY_INVENTORY');
            const key = name.normalize('NFC');
            if (seen.has(key)) throw Error('LINUX_DIRECTORY_INVENTORY_ALIAS');
            seen.add(key);
            directories.push(name);
        }
        return directories.sort();
    };
    const expected = validate(expectedDirectories);
    const retained = validate(retainedDirectories);
    if (expected.length !== retained.length || expected.some((name, index) => name !== retained[index]))
        throw Error('LINUX_DIRECTORY_LAYOUT_UNSUPPORTED');
}
