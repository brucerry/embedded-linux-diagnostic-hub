import { readFile, writeFile } from 'node:fs/promises';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile(
    'release/linux-build-info.json',
    JSON.stringify(
        {
            version,
            commit: process.env.GITHUB_SHA,
            platform: 'linux',
            arch: 'x64',
            validation: 'Packaged loopback SSH smoke; real-PC acceptance remains separate.',
        },
        null,
        4,
    ) + '\n',
);
