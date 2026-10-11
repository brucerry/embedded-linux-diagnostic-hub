import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createGeniePackage, genieAsset, GENIE_FORMATS } from './lib/genie-package.mjs';

const root = process.cwd();
const output = path.resolve(process.argv[2] ?? 'release');
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commit)
    throw Error('Companion build commit mismatch.');
if (
    process.env.GITHUB_ACTIONS === 'true' &&
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
        encoding: 'utf8',
    }).trim()
) {
    throw Error('Release companion must be built from a clean checkout.');
}
for (const format of GENIE_FORMATS) {
    const { zip, build } = await createGeniePackage(root, version, commit, format);
    const name = genieAsset(version, format);
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, name), zip);
    await writeFile(
        path.join(output, name + '.sha256'),
        `${createHash('sha256').update(zip).digest('hex')}  ${name}\n`,
    );
    console.log(`Companion packaged: ${name} (${zip.length} bytes), source ${build.sourceHash}`);
}
