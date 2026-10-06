import { zipSync } from 'fflate';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const contents = {};
async function collect(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix + entry.name;
        if (entry.isDirectory()) await collect(path.join(directory, entry.name), relative + '/');
        else if (entry.isFile())
            contents[relative] = await readFile(path.join(directory, entry.name));
    }
}
await collect('dist-site');
await mkdir('release', { recursive: true });
const destination = `release/Diagnostic-Hub-Web-${version}.zip`;
await writeFile(destination, zipSync(contents));
console.log(`Portable website: ${destination}`);
