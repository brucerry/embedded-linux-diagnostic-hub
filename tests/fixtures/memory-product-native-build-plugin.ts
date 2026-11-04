/** Private compilation transform only. No app/runtime/profile code is loaded. */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'esbuild';
import { nativeMainSourcePins, transformNativeOwnedSource } from './memory-product-native-main-transform';
import { validateHostBinding } from './memory-product-host-ownership';
export function nativeObserverBuildPlugin(sourceRoot: string, binding: unknown, sshExternal: string): Plugin {
    if (!path.isAbsolute(sourceRoot) || !(sshExternal === 'ssh2' || path.isAbsolute(sshExternal)))
        throw Error('Explicit native source and SSH external selector required.');
    const accepted = validateHostBinding(binding, 'native');
    return { name: 'private-native-product-observers', setup(builder) {
        builder.onResolve({ filter: /^ssh2$/ }, () => ({ path: sshExternal, external: true }));
        builder.onLoad({ filter: /\.ts$/ }, async args => {
            const file = path.relative(sourceRoot, args.path).split(path.sep).join('/');
            if (!Object.hasOwn(nativeMainSourcePins, file)) return;
            const source = await fs.readFile(args.path, 'utf8');
            return { contents: transformNativeOwnedSource(source, file, accepted).code, loader: 'ts' };
        });
    } };
}
