import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { distributable } from './lib/release-assets.mjs';

// Hash distributable assets only; do not include intermediate unpacked directories.
const directory = process.argv[2] ?? 'release';
const files = (await readdir(directory)).filter(distributable);
if (!files.length) throw new Error(`No distributable assets in ${directory}.`);
for (const file of files.sort()) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path.join(directory, file))) hash.update(chunk);
    await writeFile(path.join(directory, `${file}.sha256`), `${hash.digest('hex')}  ${file}\n`);
    console.log(`Checksum saved: ${file}.sha256`);
}
