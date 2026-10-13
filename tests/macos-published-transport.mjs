import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const directory = await mkdtemp(path.join(tmpdir(), 'hub-public-http-'));
const urls = [
    'https://api.github.com/repos/brucerry/embedded-linux-diagnostic-hub/releases/410956079',
    'https://api.github.com/repos/brucerry/embedded-linux-diagnostic-hub/releases/latest',
    'https://github.com/brucerry/embedded-linux-diagnostic-hub/releases/latest/download/download-run-macos.sh',
];
const deadline = Date.now() + 15 * 60 * 1000;
for (const [index, url] of urls.entries()) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        const headersFile = path.join(directory, index + '.headers');
        const bodyFile = path.join(directory, index + '.body');
        const result = spawnSync(
            'curl',
            [
                '-sS',
                '-L',
                '--proto',
                '=https',
                '--proto-redir',
                '=https',
                '--max-time',
                '30',
                '--max-filesize',
                '256000',
                '-D',
                headersFile,
                '-o',
                bodyFile,
                '-w',
                '%{http_code}',
                url,
            ],
            { encoding: 'utf8', timeout: 35000 },
        );
        const headers = await readFile(headersFile, 'utf8').catch(() => '');
        const bytes = await readFile(bodyFile).catch(() => Buffer.alloc(0));
        const allowed = headers
            .split(/\r?\n/)
            .filter((line) =>
                /^HTTP\/|^(x-ratelimit-[\w-]+|retry-after|content-type|server|x-github-request-id):/i.test(
                    line,
                ),
            );
        const rate = {};
        for (const line of allowed) {
            const at = line.indexOf(':');
            if (at > 0) rate[line.slice(0, at).toLowerCase()] = line.slice(at + 1).trim();
        }
        let info;
        try {
            info = JSON.parse(bytes.toString());
        } catch {}
        const status = Number(result.stdout.trim());
        const message = String(
            info?.message ?? (status === 200 ? '' : bytes.toString().replace(/<[^>]+>/g, ' ')),
        )
            .replace(/https?:\/\/\S+|\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted]')
            .replace(/\s+/g, ' ')
            .slice(0, 256);
        console.log(
            JSON.stringify({
                resource: url,
                curlExit: result.status,
                status,
                headers: allowed,
                message,
                bodyBytes: bytes.length,
                error: result.stderr.replace(/https?:\/\/\S+/g, '[redacted]').slice(0, 256),
            }),
        );
        if (result.status === 0 && status === 200) {
            if (index === 1) {
                assert.equal(info.id, 411238491);
                assert.equal(info.tag_name, 'v0.4.0');
                assert.equal(info.target_commitish, process.env.HUB_APP_SOURCE);
                assert.equal(info.draft, false);
                assert.equal(info.assets.length, 24);
            } else if (index === 2) {
                const source = await readFile('public/download-run-macos.sh');
                assert.ok(bytes.equals(source), 'Public helper differs from immutable tag source.');
                console.log(
                    'Public helper SHA256: ' + createHash('sha256').update(bytes).digest('hex'),
                );
            }
            break;
        }
        const reset = Number(rate['x-ratelimit-reset']) * 1000;
        const after = Number(rate['retry-after']) * 1000;
        const primary =
            rate['x-ratelimit-remaining'] === '0' &&
            /rate limit exceeded/i.test(message) &&
            reset > Date.now();
        const secondary = /secondary rate limit/i.test(message) && after > 0;
        const until = primary ? reset + 1000 : secondary ? Date.now() + after + 1000 : 0;
        if ([403, 429].includes(status) && until > Date.now() && until <= deadline && attempt < 3) {
            console.log(
                'Confirmed public HTTP throttling; respecting reset until ' +
                    new Date(until).toISOString(),
            );
            while (Date.now() < until)
                await new Promise((resolve) =>
                    setTimeout(resolve, Math.min(30000, until - Date.now())),
                );
            continue;
        }
        throw Error(
            'Public HTTP preflight failed; ambiguous responses are not retried or accepted.',
        );
    }
}
