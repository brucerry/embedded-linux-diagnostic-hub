import { execFileSync } from 'node:child_process';

export function previousRelease(releases, currentTag) {
    return (
        releases
            .filter(
                (release) =>
                    !release.draft && release.published_at && release.tag_name !== currentTag,
            )
            .sort(
                (a, b) => Date.parse(b.published_at) - Date.parse(a.published_at) || b.id - a.id,
            )[0]?.tag_name ?? null
    );
}

function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function escape(value) {
    return value.replace(/[\\`*_[\]<>]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}

export function commitNotes({ repository, currentTag, previousTag, cwd = process.cwd() }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw Error('Invalid GitHub repository.');
    for (const tag of [currentTag, previousTag].filter(Boolean)) {
        if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag)) throw Error(`Invalid release tag: ${tag}`);
        git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], cwd);
    }
    if (previousTag) {
        // Fail rather than silently compare an unrelated release branch or incomplete checkout.
        git(
            ['merge-base', '--is-ancestor', `refs/tags/${previousTag}`, `refs/tags/${currentTag}`],
            cwd,
        );
    }
    const range = previousTag
        ? `refs/tags/${previousTag}..refs/tags/${currentTag}`
        : `refs/tags/${currentTag}`;
    const fields = git(['log', '--reverse', '--format=%H%x00%s%x00%an%x00', range], cwd).split(
        '\0',
    );
    const groups = new Map();
    const titles = {
        feat: 'Features',
        fix: 'Fixes',
        docs: 'Documentation',
        test: 'Verification',
        ci: 'Build and delivery',
        build: 'Build and delivery',
        refactor: 'Maintenance',
        chore: 'Maintenance',
    };
    let count = 0;
    for (let index = 0; index + 2 < fields.length; index += 3) {
        const [hash, subject, author] = fields.slice(index, index + 3).map((value) => value.trim());
        if (!/^[0-9a-f]{40,64}$/.test(hash)) throw Error('Invalid commit log.');
        const kind = /^(\w+)(?:\([^)]*\))?!?:/.exec(subject)?.[1];
        const title = titles[kind] ?? 'Other changes';
        const lines = groups.get(title) ?? [];
        lines.push(
            `- ${escape(subject)} — ${escape(author)} ([${hash.slice(0, 7)}](https://github.com/${repository}/commit/${hash}))`,
        );
        groups.set(title, lines);
        count++;
    }
    const heading = previousTag ? `Changes since ${previousTag}` : 'Changes in the first release';
    const compare = previousTag
        ? `\n[Full comparison](https://github.com/${repository}/compare/${previousTag}...${currentTag})\n`
        : '';
    return `## ${heading}\n\n${count} commit${count === 1 ? '' : 's'} included. Draft releases and unreleased tags are not used as the baseline.\n${compare}\n${[...groups].map(([title, lines]) => `### ${title}\n\n${lines.join('\n')}`).join('\n\n')}\n`;
}
