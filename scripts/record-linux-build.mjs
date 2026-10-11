import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { LINUX_ASSET, LINUX_ARCHIVE } from './lib/release-assets.mjs';
import { genieAsset, GENIE_FORMATS } from './lib/genie-package.mjs';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const assets = {};
for (const name of [
    LINUX_ASSET,
    LINUX_ARCHIVE,
    ...GENIE_FORMATS.map((format) => genieAsset(version, format)),
]) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(`release/${name}`)) hash.update(chunk);
    assets[name] = hash.digest('hex');
}
await writeFile(
    'release/linux-build-info.json',
    JSON.stringify(
        {
            version,
            commit: process.env.GITHUB_SHA,
            platform: 'linux',
            arch: 'x64',
            assets,
            validation: 'Packaged loopback SSH smoke; real-PC acceptance remains separate.',
        },
        null,
        4,
    ) + '\n',
);
