import path from 'node:path';
import * as fs from 'node:fs';

/** Same ancestor predicates and read order as the native builder; errors propagate unchanged. */
export function linuxNativeBuildAncestorCategory(directory, uid) {
    let cursor = '/';
    for (const part of directory.split('/').filter(Boolean)) {
        cursor = path.posix.join(cursor, part);
        const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory()) return 'type';
        if (stat.isSymbolicLink()) return 'type';
        if (stat.uid !== 0 && stat.uid !== uid) return 'owner';
        if ((stat.mode & 0o7022) !== 0) return 'mode';
        if (fs.realpathSync(cursor) !== cursor) return 'canonical';
    }
    return 'accepted';
}
