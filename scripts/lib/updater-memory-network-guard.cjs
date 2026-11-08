'use strict';
let attempts = 0;
async function blockedFetch() {
    attempts++;
    throw Error('Unexpected global fetch in updater memory test.');
}
globalThis.fetch = blockedFetch;
process.on('exit', () => {
    process.stdout.write('# updater-memory-global-fetch-attempts ' + attempts + '\n');
    if (attempts !== 0 || globalThis.fetch !== blockedFetch) process.exitCode = 1;
});
