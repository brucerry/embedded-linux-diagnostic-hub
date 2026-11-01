const required = ['dist-electron/main.cjs', 'dist-electron/preload.cjs'];

/** Exact local-build comparison, not source provenance or native qualification.
 * @param {{ readBuild: (file: string) => Buffer | Promise<Buffer>,
 * readPackaged: (file: string) => Buffer | Promise<Buffer> }} readers
 */
export async function verifyDesktopPackageBundles({ readBuild, readPackaged }) {
    for (const file of required) {
        const built = await readBuild(file);
        const packaged = await readPackaged(file);
        if (!Buffer.isBuffer(built) || !Buffer.isBuffer(packaged))
            throw Error('Expected bundle bytes: ' + file);
        if (!built.equals(packaged)) throw Error('Packaged bundle mismatch: ' + file);
    }
}
