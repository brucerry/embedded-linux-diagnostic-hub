/** Historical source DATA only; never import or execute the retained Page. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const retainedPageSource = Object.freeze({
    path: 'src/features/automation/AutomationPage.tsx',
    bytes: 111913,
    sha256: '89fd638aa073619adb83d797bf56c7a200d39e0a251b1d39d630ec5f0d463a85',
    gitBlob: 'b6bbbcfb4a91f3bfa795d04977120d7b5be828e7',
});

/** Substitute one exact Page path for historical positive inputs. All other reads stay real. */
export function retainedPageReader(root: string) {
    assert.ok(path.isAbsolute(root) && path.resolve(root) === root);
    const page = path.join(root, retainedPageSource.path);
    return async (file: string): Promise<Buffer> => {
        if (file !== page) return fs.readFile(file);
        const bytes = await fs.readFile(new URL('./memory-product-e5-page.txt', import.meta.url));
        assert.equal(bytes.length, retainedPageSource.bytes, 'Retained Page byte count changed.');
        assert.equal(
            createHash('sha256').update(bytes).digest('hex'),
            retainedPageSource.sha256,
            'Retained Page source changed.',
        );
        assert.equal(
            createHash('sha1')
                .update('blob ' + bytes.length + '\0')
                .update(bytes)
                .digest('hex'),
            retainedPageSource.gitBlob,
            'Retained Page Git blob changed.',
        );
        return bytes;
    };
}
