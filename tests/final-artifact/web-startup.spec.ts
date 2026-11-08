import { test, expect } from '@playwright/test';
import * as fs from 'node:fs/promises';
import { createOwnedWebFiles, WebFileCustodyFailure } from '../../scripts/lib/owned-web-files.mjs';
import {
    readFinalWebStartupInput,
    produceFinalWebStartupCase,
    verifyFinalWebStartupCase,
} from '../../scripts/lib/final-web-startup-producer.mjs';

test('unchanged final ZIP renders public startup controls from its recorded archive bytes', async ({
    page,
    browser,
    browserName,
}) => {
    const files = createOwnedWebFiles(fs);
    const root = await files.filesystem.realpath(process.cwd());
    const selected = process.env.HUB_FINAL_WEB_SELECTION;
    if (!selected) throw Error('Final web selection is missing.');
    const loaded = await readFinalWebStartupInput(root, selected, files.filesystem).catch(
        (error) => {
            throw new WebFileCustodyFailure(error, files.owner);
        },
    );
    files.owner.assertSettled();
    const { input, fingerprint } = loaded;
    expect(fingerprint).toBe(process.env.HUB_FINAL_WEB_VALIDATED_INPUT);
    expect(browserName).toBe(process.env.HUB_FINAL_WEB_ENGINE ?? 'chromium');
    const result = await produceFinalWebStartupCase(input, page, undefined, browserName);
    const checked = verifyFinalWebStartupCase(result.bytes, input, browser.version(), browserName);
    expect(checked.status).toBe('artifact-bound-startup-only');
    expect(checked.releaseAcceptance).toBe(false);
    expect(page.isClosed()).toBe(true);
    // The JSON reporter retains this capped case evidence. Its attachment alone is not a job pass:
    // the caller must also inspect the terminal command/report, including global teardown errors.
    await test.info().attach('final-web-startup-case.json', {
        body: result.bytes,
        contentType: 'application/json',
    });
});
