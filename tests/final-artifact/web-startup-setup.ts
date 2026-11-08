import * as fs from 'node:fs/promises';
import { createOwnedWebFiles, WebFileCustodyFailure } from '../../scripts/lib/owned-web-files.mjs';
import { readFinalWebStartupInput } from '../../scripts/lib/final-web-startup-producer.mjs';

// Playwright runs global setup before browser fixtures. Missing/invalid archive input fails here.
export default async function setup() {
    const files = createOwnedWebFiles(fs);
    const root = await files.filesystem.realpath(process.cwd());
    const selection = process.env.HUB_FINAL_WEB_SELECTION;
    if (!selection) throw Error('Final web selection is missing.');
    try {
        const { fingerprint } = await readFinalWebStartupInput(root, selection, files.filesystem);
        files.owner.assertSettled();
        process.env.HUB_FINAL_WEB_VALIDATED_INPUT = fingerprint;
    } catch (error) {
        throw new WebFileCustodyFailure(error, files.owner);
    }
}
