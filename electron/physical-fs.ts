import * as nodeFS from 'node:fs';
import { createRequire } from 'node:module';

/** Disk ownership, inventory and checksums must inspect archives as physical files. */
function diskFileSystem(): typeof nodeFS {
    if (!process.versions.electron) return nodeFS;
    // Electron patches node:fs and its promises in both application and Node modes.
    // Load its built-in physical implementation without changing process.noAsar or
    // bundling a replacement for the runtime built-in. Never fall back in Electron.
    const loadBuiltin = createRequire(process.execPath);
    return loadBuiltin('original-fs') as typeof nodeFS;
}

export const physicalFS = diskFileSystem();
