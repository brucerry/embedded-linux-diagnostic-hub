import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { gt, rcompare, valid } from 'semver';
import type { UpdateStatus } from '../shared/types';

const REPO = 'brucerry/embedded-linux-diagnostic-hub';
const API = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
const PREFIX = `https://github.com/${REPO}/releases/download/`;
const MAX_BYTES = 512 * 1024 * 1024;
interface Asset {
    name: string;
    browser_download_url: string;
    size: number;
}
interface Candidate {
    version: string;
    prerelease: boolean;
    publishedAt: string;
    notes: string;
    asset: Asset;
    checksum: Asset;
}

// Only the native process selects URLs and paths; the renderer supplies no executable location.
export class ReleaseUpdater {
    private candidate: Candidate | null = null;
    private ready: { file: string; hash: string } | null = null;
    private busy = false;
    private verified = new Map<string, { file: string; hash: string }>();

    constructor(
        private currentVersion: string,
        private directory: string,
        private platform: string,
        private arch: string,
        private packaged: boolean,
        private request: typeof fetch = (input, init) => fetch(input, init),
    ) {}

    private get assetName() {
        if (this.arch !== 'x64') return null;
        return this.platform === 'win32'
            ? 'Diagnostic-Hub.exe'
            : this.platform === 'linux'
              ? 'Diagnostic-Hub-linux-x64.AppImage'
              : null;
    }

    private async get(url: string, timeout = 30_000) {
        const response = await this.request(url, {
            headers: { 'User-Agent': 'Diagnostic-Hub', Accept: 'application/vnd.github+json' },
            signal: AbortSignal.timeout(timeout),
            cache: 'no-store',
        });
        if (!response.ok)
            throw new Error(`GitHub request failed (${response.status}). Try again later.`);
        return response;
    }

    private async text(response: Response, limit: number): Promise<string> {
        if (!response.body) throw new Error('GitHub returned an empty response.');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.length;
                if (size > limit) throw new Error('GitHub response exceeds the expected size.');
                chunks.push(value);
            }
            return Buffer.concat(chunks).toString('utf8');
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
    }

    async check(includePrereleases: boolean): Promise<UpdateStatus> {
        if (typeof includePrereleases !== 'boolean') throw new Error('Invalid release selection.');
        if (this.busy) throw new Error('An update operation is already running.');
        this.busy = true;
        this.candidate = null;
        this.ready = null;
        try {
            const releases: unknown = JSON.parse(
                await this.text(await this.get(API), 5 * 1024 * 1024),
            );
            if (!Array.isArray(releases)) throw new Error('GitHub returned invalid release data.');
            const candidates: Candidate[] = [];
            for (const release of releases) {
                if (!release || release.draft || (!includePrereleases && release.prerelease))
                    continue;
                const version =
                    typeof release.tag_name === 'string' && release.tag_name.startsWith('v')
                        ? valid(release.tag_name.slice(1))
                        : null;
                if (
                    !version ||
                    release.tag_name !== `v${version}` ||
                    !gt(version, this.currentVersion) ||
                    !Array.isArray(release.assets)
                )
                    continue;
                const asset = release.assets.find((item: Asset) => item?.name === this.assetName);
                const checksum = release.assets.find(
                    (item: Asset) => item?.name === `${this.assetName}.sha256`,
                );
                const validAsset = (item: Asset | undefined) =>
                    item &&
                    Number.isSafeInteger(item.size) &&
                    item.size > 0 &&
                    item.size <= MAX_BYTES &&
                    item.browser_download_url === `${PREFIX}v${version}/${item.name}`;
                if (!validAsset(asset) || !validAsset(checksum) || checksum.size > 4096) continue;
                candidates.push({
                    version,
                    prerelease: Boolean(release.prerelease),
                    publishedAt:
                        typeof release.published_at === 'string' ? release.published_at : '',
                    notes: typeof release.body === 'string' ? release.body.slice(0, 12000) : '',
                    asset,
                    checksum,
                });
            }
            candidates.sort((a, b) => rcompare(a.version, b.version));
            this.candidate = candidates[0] ?? null;
            const release = this.candidate;
            const cached = release && this.verified.get(release.version);
            if (cached) {
                try {
                    await this.verify(cached);
                    this.ready = cached;
                } catch {
                    this.verified.delete(release!.version);
                }
            }
            return {
                currentVersion: this.currentVersion,
                installable: this.packaged && Boolean(this.assetName),
                readyPath: this.ready?.file,
                release: release && {
                    version: release.version,
                    prerelease: release.prerelease,
                    publishedAt: release.publishedAt,
                    notes: release.notes,
                },
            };
        } finally {
            this.busy = false;
        }
    }

    assertCanDownload(): void {
        if (!this.packaged) throw new Error('Run a packaged application to install updates.');
        if (this.busy) throw new Error('An update operation is already running.');
        if (!this.candidate) throw new Error('Check for a newer compatible release first.');
    }

    async download(): Promise<string> {
        this.assertCanDownload();
        const candidate = this.candidate!;
        if (this.ready) {
            this.busy = true;
            try {
                return await this.verify(this.ready);
            } catch (error) {
                this.ready = null;
                this.verified.delete(candidate.version);
                throw error;
            } finally {
                this.busy = false;
            }
        }
        this.busy = true;
        this.ready = null;
        const folder = path.join(this.directory, candidate.version);
        const file = path.join(folder, candidate.asset.name);
        const staging = `${file}.${randomUUID()}.part`;
        try {
            const checksumResponse = await this.get(candidate.checksum.browser_download_url);
            const checksum = (await this.text(checksumResponse, 4096)).trim();
            const match = /^([a-fA-F0-9]{64})\s+\*?([^\r\n]+)$/.exec(checksum);
            if (!match || match[2] !== candidate.asset.name)
                throw new Error('Invalid release checksum file.');
            const expected = match[1].toLowerCase();
            await mkdir(folder, { recursive: true, mode: 0o700 });
            const response = await this.get(candidate.asset.browser_download_url, 300_000);
            if (!response.body) throw new Error('The release download is empty.');
            const handle = await open(staging, 'wx', 0o600);
            let size = 0;
            const hash = createHash('sha256');
            let header = Buffer.alloc(0);
            try {
                for await (const chunk of response.body) {
                    size += chunk.length;
                    if (size > candidate.asset.size || size > MAX_BYTES)
                        throw new Error('Release download exceeds its expected size.');
                    hash.update(chunk);
                    if (header.length < 12)
                        header = Buffer.concat([header, Buffer.from(chunk)]).subarray(0, 12);
                    // FileHandle.write may perform a partial write; writeFile handles the complete chunk.
                    await handle.writeFile(chunk);
                }
            } finally {
                await handle.close();
            }
            if (size !== candidate.asset.size || hash.digest('hex') !== expected)
                throw new Error('Release checksum verification failed. No update was installed.');
            const executable =
                this.platform === 'win32'
                    ? header.subarray(0, 2).toString() === 'MZ'
                    : header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
                      header.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 0x02]));
            if (!executable)
                throw new Error('The release is not a compatible portable executable.');
            await chmod(staging, 0o700);
            await rename(staging, file);
            this.ready = { file, hash: expected };
            this.verified.set(candidate.version, this.ready);
            return file;
        } finally {
            await rm(staging, { force: true }).finally(() => {
                this.busy = false;
            });
        }
    }

    private async verify(ready: { file: string; hash: string }): Promise<string> {
        const hash = createHash('sha256');
        let size = 0;
        for await (const chunk of createReadStream(ready.file)) {
            size += chunk.length;
            if (size > MAX_BYTES)
                throw new Error('The downloaded update has changed. Download it again.');
            hash.update(chunk);
        }
        if (hash.digest('hex') !== ready.hash)
            throw new Error(
                'The downloaded update has changed. Download it again before restarting.',
            );
        return ready.file;
    }

    async executable(): Promise<string> {
        if (this.busy || !this.ready) throw new Error('Download and verify an update first.');
        return this.verify(this.ready);
    }
}
