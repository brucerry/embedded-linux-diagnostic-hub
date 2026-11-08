import { hashUpdateFile } from './update-owned-file';
import { UpdateOwnership, updateErrors } from './update-ownership';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { gt, rcompare, valid } from 'semver';
import type { UpdateStatus, UpdateProgress } from '../shared/types';

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
        private delivery: 'portable' | 'installed' | 'unavailable' = 'portable',
        private ownership = new UpdateOwnership(),
    ) {}

    private get assetName() {
        if (this.delivery !== 'portable' || this.arch !== 'x64') return null;
        return this.platform === 'win32'
            ? 'Diagnostic-Hub.exe'
            : this.platform === 'linux'
              ? 'Diagnostic-Hub-linux-x64.AppImage'
              : null;
    }

    private assertAutomaticDelivery(): void {
        if (this.delivery !== 'portable')
            throw Error(
                this.delivery === 'installed'
                    ? 'Automatic updates are not qualified for this installed delivery. Use the verified setup for Update or Repair.'
                    : 'Automatic updates require a verified supported delivery location. Use the verified setup or portable download.',
            );
    }

    private bodies = new WeakMap<Response, ReturnType<UpdateOwnership['hold']>>();
    private async get(url: string, timeout = 30_000) {
        const request = this.ownership.hold('HTTP request', { url });
        let response: Response;
        try {
            response = await this.request(url, {
                headers: { 'User-Agent': 'Diagnostic-Hub', Accept: 'application/vnd.github+json' },
                signal: AbortSignal.timeout(timeout),
                cache: 'no-store',
            });
        } catch (error) {
            request.acknowledge();
            throw error;
        }
        if (response.body)
            this.bodies.set(response, this.ownership.hold('HTTP response body', response.body));
        request.acknowledge();
        if (!response.ok) {
            const primary = Error(`GitHub request failed (${response.status}). Try again later.`);
            this.ownership.diagnose(primary);
            const cleanup: unknown[] = [];
            if (response.body) {
                try {
                    await response.body.cancel();
                    this.bodies.get(response)?.acknowledge();
                } catch (error) {
                    this.bodies.get(response)?.blocked(error);
                    cleanup.push(error);
                }
            }
            updateErrors({ failed: true, error: primary }, cleanup);
        }
        return response;
    }

    private async consume(
        response: Response,
        chunk: (value: Uint8Array) => Promise<void> | void,
        before?: () => Promise<void>,
    ) {
        if (!response.body) throw Error('The response is empty.');
        const body = this.bodies.get(response);
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let lock: ReturnType<UpdateOwnership['hold']> | undefined;
        let ended = false;
        const primary = { failed: false, error: undefined as unknown },
            cleanup: unknown[] = [];
        try {
            reader = response.body.getReader();
            lock = this.ownership.hold('HTTP reader lock', reader);
            await before?.();
            while (true) {
                const next = await reader.read();
                if (next.done) {
                    ended = true;
                    body?.acknowledge();
                    break;
                }
                await chunk(next.value);
            }
        } catch (error) {
            primary.failed = true;
            primary.error = error;
            this.ownership.diagnose(error);
        }
        if (!ended) {
            try {
                if (reader) await reader.cancel();
                else await response.body.cancel();
                body?.acknowledge();
            } catch (error) {
                body?.blocked(error);
                cleanup.push(error);
            }
        }
        if (reader) {
            try {
                reader.releaseLock();
                lock?.acknowledge();
            } catch (error) {
                lock?.blocked(error);
                cleanup.push(error);
            }
        }
        updateErrors(primary, cleanup);
    }
    private async text(response: Response, limit: number): Promise<string> {
        const chunks: Uint8Array[] = [];
        let size = 0;
        await this.consume(response, (value) => {
            size += value.length;
            if (size > limit) throw Error('GitHub response exceeds the expected size.');
            chunks.push(value);
        });
        return Buffer.concat(chunks).toString('utf8');
    }

    async check(includePrereleases: boolean): Promise<UpdateStatus> {
        if (typeof includePrereleases !== 'boolean') throw new Error('Invalid release selection.');
        if (this.busy || this.ownership.held)
            throw new Error('An update operation or its cleanup is already running.');
        if (!this.assetName)
            return {
                currentVersion: this.currentVersion,
                installable: false,
                release: null,
                installationUnavailableReason:
                    this.delivery === 'installed'
                        ? 'Automatic updates are not qualified for this installed delivery. Use the verified setup for Update or Repair.'
                        : this.delivery === 'unavailable'
                          ? 'Automatic updates require a verified supported delivery location. Use the verified setup or portable download.'
                          : this.platform === 'darwin'
                            ? 'Automatic updates are unavailable on macOS. Quit Diagnostic Hub and use the verified Mac installer; normal signing and Gatekeeper policy still apply.'
                            : 'Automatic updates are unavailable on this platform. Check GitHub releases for manually supported downloads.',
                ...(this.platform === 'darwin' && (this.arch === 'x64' || this.arch === 'arm64')
                    ? {
                          manualUpdate: {
                              platform: 'darwin' as const,
                              architecture: this.arch,
                              defaultDestination: '~/Applications/Diagnostic Hub.app',
                              verificationCommand: 'shasum -a 256 -c download-run-macos.sh.sha256',
                          },
                      }
                    : {}),
            };
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
                } catch (error) {
                    this.verified.delete(release!.version);
                    if (this.ownership.held) throw error;
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
        this.assertAutomaticDelivery();
        if (!this.assetName) throw new Error('Automatic updates are unavailable on this platform.');
        if (!this.packaged) throw new Error('Run a packaged application to install updates.');
        if (this.busy || this.ownership.held)
            throw new Error('An update operation or its cleanup is already running.');
        if (!this.candidate) throw new Error('Check for a newer compatible release first.');
    }

    async download(progress: (value: UpdateProgress) => void = () => {}): Promise<string> {
        this.assertCanDownload();
        const candidate = this.candidate!;
        if (this.ready) {
            this.busy = true;
            try {
                progress({ stage: 'verify', message: 'Rechecking the cached executable…' });
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
        const temporary = this.ownership.hold('payload staging', staging);
        let stagingOwned = false,
            creationUnconfirmed = false;
        const primary = { failed: false, error: undefined as unknown },
            cleanup: unknown[] = [];
        let result: string | undefined;
        try {
            progress({ stage: 'preparing', message: 'Reading release checksum…' });
            const checksum = (
                await this.text(await this.get(candidate.checksum.browser_download_url), 4096)
            ).trim();
            const match = /^([a-fA-F0-9]{64})\s+\*?([^\r\n]+)$/.exec(checksum);
            if (!match || match[2] !== candidate.asset.name)
                throw Error('Invalid release checksum file.');
            const expected = match[1].toLowerCase();
            await mkdir(folder, { recursive: true, mode: 0o700 });
            const response = await this.get(candidate.asset.browser_download_url, 300_000);
            let handle: Awaited<ReturnType<typeof open>> | undefined;
            let custody: ReturnType<UpdateOwnership['hold']> | undefined;
            let size = 0,
                header = Buffer.alloc(0),
                lastProgress = 0;
            const hash = createHash('sha256');
            const writeFailure = { failed: false, error: undefined as unknown },
                closeErrors: unknown[] = [];
            try {
                await this.consume(
                    response,
                    async (value) => {
                        size += value.length;
                        if (size > candidate.asset.size || size > MAX_BYTES)
                            throw Error('Release download exceeds its expected size.');
                        hash.update(value);
                        if (header.length < 12)
                            header = Buffer.concat([header, Buffer.from(value)]).subarray(0, 12);
                        await handle!.writeFile(value);
                        if (Date.now() - lastProgress >= 100 || size === candidate.asset.size) {
                            progress({
                                stage: 'download',
                                message: 'Downloading release bytes…',
                                receivedBytes: size,
                                totalBytes: candidate.asset.size,
                                stagingPath: staging,
                            });
                            lastProgress = Date.now();
                        }
                    },
                    async () => {
                        progress({
                            stage: 'download',
                            message: 'Downloading release bytes…',
                            receivedBytes: 0,
                            totalBytes: candidate.asset.size,
                            stagingPath: staging,
                        });
                        creationUnconfirmed = true;
                        try {
                            handle = await open(staging, 'wx', 0o600);
                        } catch (error) {
                            if (
                                error &&
                                typeof error === 'object' &&
                                (error as NodeJS.ErrnoException).code === 'EEXIST'
                            )
                                creationUnconfirmed = false;
                            throw error;
                        }
                        creationUnconfirmed = false;
                        stagingOwned = true;
                        custody = this.ownership.hold('payload handle', handle);
                    },
                );
            } catch (error) {
                writeFailure.failed = true;
                writeFailure.error = error;
                this.ownership.diagnose(error);
            }
            if (handle) {
                try {
                    await handle.close();
                    custody!.acknowledge();
                } catch (error) {
                    custody!.blocked(error);
                    closeErrors.push(error);
                }
            }
            updateErrors(writeFailure, closeErrors);
            progress({
                stage: 'verify',
                message: 'Verifying size, SHA-256 and executable format…',
                stagingPath: staging,
            });
            if (size !== candidate.asset.size || hash.digest('hex') !== expected)
                throw Error('Release checksum verification failed. No update was installed.');
            const executable =
                this.platform === 'win32'
                    ? header.subarray(0, 2).toString() === 'MZ'
                    : header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
                      header.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 0x02]));
            if (!executable) throw Error('The release is not a compatible portable executable.');
            progress({
                stage: 'install',
                message: 'Committing the verified executable…',
                stagingPath: staging,
            });
            await chmod(staging, 0o700);
            const publication = this.ownership.hold('payload publication', file);
            try {
                await rename(staging, file);
                this.ownership.publication('payload', 'published');
                publication.acknowledge();
            } catch (error) {
                this.ownership.publication('payload', 'uncertain');
                publication.blocked(error);
                throw error;
            }
            stagingOwned = false; // Successful rename consumed the acquired staging name.
            temporary.acknowledge();
            this.ready = { file, hash: expected };
            this.verified.set(candidate.version, this.ready);
            result = file;
        } catch (error) {
            primary.failed = true;
            primary.error = error;
            this.ownership.diagnose(error);
        }
        try {
            if (stagingOwned) {
                try {
                    await rm(staging, { force: true });
                    temporary.acknowledge();
                } catch (error) {
                    temporary.blocked(error);
                    cleanup.push(error);
                }
            } else if (creationUnconfirmed) {
                temporary.blocked(primary.error);
            } else {
                temporary.acknowledge();
            }
        } finally {
            this.busy = false;
        }
        updateErrors(primary, cleanup);
        return result!;
    }

    private async verify(ready: { file: string; hash: string }): Promise<string> {
        if ((await hashUpdateFile(this.ownership, ready.file, MAX_BYTES)) !== ready.hash)
            throw Error('The downloaded update has changed. Download it again before restarting.');
        return ready.file;
    }

    handoffInfo() {
        this.assertAutomaticDelivery();
        if (!this.ready || !this.candidate) throw Error('Download and verify an update first.');
        return {
            previousVersion: this.currentVersion,
            version: this.candidate.version,
            executable: this.ready.file,
            hash: this.ready.hash,
        };
    }
    async executable(): Promise<string> {
        this.assertAutomaticDelivery();
        if (this.busy || this.ownership.held || !this.ready)
            throw new Error('Download and verify an update first.');
        const ready = this.ready;
        const candidate = this.candidate;
        this.busy = true;
        try {
            return await this.verify(ready);
        } catch (error) {
            if (this.ready === ready) this.ready = null;
            if (candidate && this.verified.get(candidate.version) === ready)
                this.verified.delete(candidate.version);
            throw error;
        } finally {
            this.busy = false;
        }
    }
}
