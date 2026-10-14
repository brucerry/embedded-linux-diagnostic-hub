import { execFileSync } from 'node:child_process';

function releaseSectionCandidates(body) {
    // Identify section-like lines first; malformed Markdown/spacing must not hide extra headings.
    return [
        ...body.matchAll(
            /^[\t ]*(?:#{1,6}[\t ]*)?(?:\p{Extended_Pictographic}\uFE0F?[\t ]*)?(?:Description|Changes|Commits|Links):[^\r\n]*$/gimu,
        ),
    ];
}
export function meaningfulReleaseLink(line) {
    const legacy = line.trim().match(/^(.+?) - (https?:\/\/\S+)$/);
    const markdown = line.trim().match(/^\[([^\r\n]+)\]\((https?:\/\/[^\s]+)\)$/);
    const match = legacy ?? markdown;
    if (!match || !match[1].trim())
        throw Error('Release links require a meaningful Markdown label or legacy name - URL.');
    let destination;
    try {
        destination = new URL(match[2]);
    } catch {
        throw Error('Release links require a valid absolute HTTP(S) destination.');
    }
    if (
        !['http:', 'https:'].includes(destination.protocol) ||
        !destination.hostname ||
        /^\.+$/.test(destination.hostname) ||
        destination.username ||
        destination.password ||
        match[2].includes('\\')
    )
        throw Error('Release links require a valid absolute HTTP(S) destination.');
    return legacy
        ? '[' + legacy[1].replace(/[\[\]]/g, '\\$&') + '](' + legacy[2] + ')'
        : line.trim();
}
export function meaningfulReleaseLinks(body) {
    const headers = releaseSectionCandidates(body).map((match) => {
        const exact = /^(?:(?:📋|🔧|🔖|🔗) )?(Description|Changes|Commits|Links):$/.exec(match[0]);
        return exact ? exact[1] + ':' : null;
    });
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

export function releaseSectionHeadings(tag) {
    const version = /^v(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/.exec(tag);
    if (!version) throw Error('Invalid release tag for note headings.');
    const decorated =
        Number(version[1]) > 0 ||
        Number(version[2]) > 5 ||
        (Number(version[2]) === 5 && Number(version[3]) >= 1);
    const labels = ['Description', 'Changes', 'Commits', 'Links'];
    const emojis = ['📋', '🔧', '🔖', '🔗'];
    return labels.map((label, index) => (decorated ? emojis[index] + ' ' : '') + label + ':');
}

export function validateFinalReleaseNotes(body, tag) {
    const expected = releaseSectionHeadings(tag);
    const headers = releaseSectionCandidates(body);
    if (
        headers.length !== expected.length ||
        headers.some((header, index) => header[0] !== expected[index]) ||
        !body.startsWith(expected[0] + '\n')
    )
        throw Error('Final release notes require the version-specific four headings in order.');
    const sections = headers.map((header, index) =>
        body
            .slice(header.index + header[0].length, headers[index + 1]?.index ?? body.length)
            .trim(),
    );
    if (
        sections.some((section) => !section) ||
        [sections[1], sections[2]].some((section) =>
            section.split('\n').some((line) => !line.startsWith('- ')),
        )
    )
        throw Error(
            'Final release note sections must be nonempty, with Changes and Commits as bullet lists.',
        );
    if (meaningfulReleaseLinks(body) !== body)
        throw Error('Final release links require complete meaningful Markdown destinations.');
    return body;
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
    const headings = releaseSectionHeadings(currentTag);
    return `${headings[0]}\n${description}\n\n${headings[1]}\n${changes}\n\n${headings[2]}\n${commits.join('\n') || '- No new commits.'}\n\n${headings[3]}\n${[...new Set(links.map(meaningfulReleaseLink))].join('\n')}\n`;
}
