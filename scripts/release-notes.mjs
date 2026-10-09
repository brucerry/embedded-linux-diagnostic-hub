import { readFile, writeFile } from 'node:fs/promises';
import { previousRelease, releasePageNotes } from './lib/release-notes.mjs';

const repository = process.env.GITHUB_REPOSITORY;
const currentTag = process.env.GITHUB_REF_NAME;
if (!repository || !currentTag) throw Error('GITHUB_REPOSITORY and GITHUB_REF_NAME are required.');
const releases = [];
for (let page = 1; ; page++) {
    const response = await fetch(
        `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
        {
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'Diagnostic-Hub-release-notes',
                ...(process.env.GH_TOKEN
                    ? { Authorization: `Bearer ${process.env.GH_TOKEN}` }
                    : {}),
            },
            signal: AbortSignal.timeout(30000),
        },
    );
    if (!response.ok)
        throw Error(`Cannot determine the previous published release (${response.status}).`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw Error('Invalid GitHub releases response.');
    releases.push(...batch);
    if (batch.length < 100) break;
}
const previousTag = previousRelease(releases, currentTag);
let highlights = '';
try {
    highlights = await readFile(`docs/releases/${currentTag}.md`, 'utf8');
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
const packageNotes = await readFile('release/notes.md', 'utf8');
await writeFile(
    'release/notes.md',
    releasePageNotes({ repository, currentTag, previousTag, highlights, packageNotes }),
);
console.log(`Release notes prepared: ${previousTag ?? 'repository start'} -> ${currentTag}`);
