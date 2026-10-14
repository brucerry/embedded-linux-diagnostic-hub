import { execFileSync } from 'node:child_process';

export function meaningfulReleaseLink(line) {
    const legacy = line.trim().match(/^(.+?) - (https?:\/\/\S+)$/);
    if (legacy) return '[' + legacy[1].replace(/[\[\]]/g, '\\$&') + '](' + legacy[2] + ')';
    if (/^\[[^\r\n]+\]\(https?:\/\/[^\s]+\)$/.test(line.trim())) return line.trim();
    throw Error('Release links require a meaningful Markdown label or legacy name - URL.');
}
export function meaningfulReleaseLinks(body) {
    const headers = [
        ...body.matchAll(/^(?:(?:📋|🔧|🔖|🔗) )?(Description|Changes|Commits|Links):$/gm),
    ].map((match) => match[1] + ':');
    if (
        JSON.stringify(headers) !==
        JSON.stringify(['Description:', 'Changes:', 'Commits:', 'Links:'])
    )
        throw Error('Preserve the four literal release sections.');
    const found = /\n(?:(?:📋|🔧|🔖|🔗) )?Links:\n/.exec(body);
    const marker = found?.[0] ?? '';
    const index = found?.index ?? -1;
    if (index < 0) throw Error('Missing Links section.');
    const prefix = body.slice(0, index + marker.length);
    const links = body
        .slice(index + marker.length)
        .trim()
        .split('\n')
        .filter(Boolean);
    return prefix + links.map(meaningfulReleaseLink).join('\n') + '\n';
}

export function previousRelease(releases, currentTag) {
    const current = releases.find(
        (release) => release.tag_name === currentTag && !release.draft && release.published_at,
    );
    return (
        releases
            .filter(
                (release) =>
                    !release.draft &&
                    release.published_at &&
                    release.tag_name !== currentTag &&
                    (!current ||
                        Date.parse(release.published_at) < Date.parse(current.published_at)),
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

function releaseRange({ repository, currentTag, previousTag, cwd = process.cwd() }) {
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
    return previousTag
        ? `refs/tags/${previousTag}..refs/tags/${currentTag}`
        : `refs/tags/${currentTag}`;
}

export function commitNotes({ repository, currentTag, previousTag, cwd = process.cwd() }) {
    const range = releaseRange({ repository, currentTag, previousTag, cwd });
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

export function releasePageNotes({
    repository,
    currentTag,
    previousTag,
    highlights = '',
    packageNotes = '',
    cwd = process.cwd(),
}) {
    releaseRange({ repository, currentTag, previousTag, cwd });
    const body = highlights.trim() || packageNotes.trim();
    if (!body) throw Error('Release notes cannot be empty.');
    const commits = commitNotes({ repository, currentTag, previousTag, cwd })
        .split('\n')
        .filter((line) => line.startsWith('- '));
    const sourceLinks = [...body.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g)].map(
        (match) => `${match[1]} - ${match[2]}`,
    );
    const clean = (value) => value.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1').trim();
    const structured = /^(?:#{1,6} )?(?:(?:📋|🔧|🔖|🔗) )?Description:\s*$/m.test(body);
    let description, changes, links;
    if (structured) {
        const sections = body.split(
            /^(?:#{1,6} )?(?:(?:📋|🔧|🔖|🔗) )?(Description|Changes|Commits|Links):\s*$/m,
        );
        const names = sections.filter((_value, index) => index % 2 === 1);
        if (names.join(',') !== 'Description,Changes,Commits,Links')
            throw Error(
                'Release notes require exactly Description, Changes, Commits and Links in that order.',
            );
        description = clean(sections[2]);
        changes = clean(sections[4]);
        links = sections[8].trim().split('\n').filter(Boolean);
        for (const line of links) meaningfulReleaseLink(line);
    } else {
        const paragraphs = body
            .split(/\n\s*\n/)
            .filter((paragraph) => !paragraph.trim().startsWith('- ') && !/^\s*\[/.test(paragraph));
        description =
            clean(paragraphs.join('\n\n').replace(/^#{1,6} .*$/gm, '')) ||
            'Portable SSH diagnostics for embedded Linux on Windows, Linux and the web.';
        const bullets = [];
        for (const line of body.split('\n')) {
            if (/^- /.test(line)) bullets.push(clean(line));
            else if (/^\s+\S/.test(line) && bullets.length)
                bullets[bullets.length - 1] += ' ' + clean(line);
        }
        changes = bullets.join('\n') || commits.join('\n') || '- Initial release.';
        links = sourceLinks;
    }
    if (
        !description ||
        !changes ||
        changes.split('\n').some((line) => line && !line.startsWith('- '))
    )
        throw Error('Description is required and changes must be bullet points.');
    const signing = packageNotes.match(
        /Windows Authenticode signature: valid\.|Unsigned (?:engineering preview|build)\. Windows may show an unknown-publisher warning\./,
    )?.[0];
    if (signing && !description.includes(signing)) description += '\n' + signing;
    const comparison = previousTag
        ? `Full comparison - https://github.com/${repository}/compare/${previousTag}...${currentTag}`
        : `Source - https://github.com/${repository}/tree/${currentTag}`;
    links = [
        ...new Set([
            ...links,
            comparison,
            `Downloads and setup - https://github.com/${repository}/blob/${currentTag}/docs/downloads.md`,
        ]),
    ];
    const version = /^v(\d+)\.(\d+)\.(\d+)/.exec(currentTag);
    const decorated =
        version &&
        (Number(version[1]) > 0 ||
            Number(version[2]) > 5 ||
            (Number(version[2]) === 5 && Number(version[3]) >= 1));
    const heading = (label) =>
        (decorated
            ? { Description: '📋 ', Changes: '🔧 ', Commits: '🔖 ', Links: '🔗 ' }[label]
            : '') +
        label +
        ':';
    return `${heading('Description')}\n${description}\n\n${heading('Changes')}\n${changes}\n\n${heading('Commits')}\n${commits.join('\n') || '- No new commits.'}\n\n${heading('Links')}\n${[...new Set(links.map(meaningfulReleaseLink))].join('\n')}\n`;
}
