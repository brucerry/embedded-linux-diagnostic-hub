import fs from 'node:fs';
import path from 'node:path';
import { NtExecutable, NtExecutableResource } from 'pe-library';
import { Resource, Data } from 'resedit';
import { extractFile } from '@electron/asar';
const directory = process.argv[2];
if (!directory) throw Error('Usage: node scripts/verify-package.mjs /path/to/packaging-output');
const expected = Data.IconFile.from(fs.readFileSync('public/app-icon.ico')).icons.map((item) =>
    Buffer.from(item.data.isRaw() ? item.data.bin : item.data.generate()),
);
for (const file of ['Diagnostic-Hub.exe', 'win-unpacked/Diagnostic Hub.exe']) {
    const executable = NtExecutable.from(fs.readFileSync(path.join(directory, file)));
    const resources = NtExecutableResource.from(executable);
    const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
    const matches = groups.some((group) => {
        const actual = group
            .getIconItemsFromEntries(resources.entries)
            .map((icon) => Buffer.from(icon.isRaw() ? icon.bin : icon.generate()));
        return expected.every((icon) => actual.some((item) => item.equals(icon)));
    });
    if (!matches) throw Error('Executable icon does not match the shared brand: ' + file);
    console.log('Verified all seven brand icon resolutions in ' + file);
}
const archive = path.join(directory, 'win-unpacked/resources/app.asar');
for (const folder of ['dist/assets', 'dist-electron'])
    for (const file of fs.readdirSync(folder)) {
        if (
            !fs
                .readFileSync(path.join(folder, file))
                .equals(extractFile(archive, path.join(folder, file)))
        )
            throw Error('Packaged bundle mismatch: ' + file);
    }
for (const file of ['app-icon.svg', 'app-icon.png', 'app-icon.ico'])
    if (
        !fs
            .readFileSync(path.join('public', file))
            .equals(extractFile(archive, path.join('dist', file)))
    )
        throw Error('Packaged icon mismatch: ' + file);
for (const file of [
    ...fs.readdirSync('dist/assets').map((f) => 'assets/' + f),
    'app-icon.svg',
    'app-icon.png',
    'app-icon.ico',
])
    if (!fs.readFileSync('dist/' + file).equals(fs.readFileSync('dist-web/' + file)))
        throw Error('Desktop/web asset mismatch: ' + file);
console.log('Packaged native/renderer/icon bundles verified; desktop and website assets match.');
