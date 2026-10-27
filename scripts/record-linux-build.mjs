import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLinuxBuildRecord, validatePrivateLinuxSource, linuxBuildJSON,
    LINUX_BUILD_ASSETS } from './lib/linux-build-record.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function linuxBuildArguments(args) {
    if (args.length === 1 && args[0] === '--help') return { help: true };
    const result = { mode: 'published-release' }, allowed = new Set([
        'mode', 'source-record', 'source-record-sha256', 'validation-result', 'validation-sha256']);
    const seen = new Set();
    for (const arg of args) {
        const match = /^--([a-z0-9-]+)=(.+)$/.exec(arg);
        if (!match || !allowed.has(match[1]) || seen.has(match[1])) throw Error('LINUX_BUILD_ARGUMENTS');
        seen.add(match[1]); result[match[1]] = match[2];
    }
    if (!['published-release', 'private-build'].includes(result.mode) ||
        Boolean(result['validation-result']) !== Boolean(result['validation-sha256']) ||
        (result.mode === 'private-build' ? !result['source-record'] || !result['source-record-sha256'] :
            result['source-record'] !== undefined || result['source-record-sha256'] !== undefined))
        throw Error('LINUX_BUILD_ARGUMENTS');
    for (const key of ['source-record-sha256', 'validation-sha256'])
        if (result[key] !== undefined && !/^[a-f0-9]{64}$/.test(result[key])) throw Error('LINUX_BUILD_ARGUMENTS');
    return result;
}
/** Injected command path permits inert contract tests; import/help never select concrete IO. */
export async function recordLinuxBuild(args, env, io) {
    const flags = linuxBuildArguments(args);
    if (flags.help) return { help: true };
    const commit = env.GITHUB_SHA;
    if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) throw Error('LINUX_BUILD_COMMIT');
    const pkg = linuxBuildJSON(await io.readSmall('package.json', 65536));
    let source = null, sourceRecordSHA256 = null;
    if (flags.mode === 'private-build') {
        const bytes = await io.readSmall(flags['source-record'], 65536);
        source = validatePrivateLinuxSource(linuxBuildJSON(bytes)); sourceRecordSHA256 = hash(bytes);
        if (sourceRecordSHA256 !== flags['source-record-sha256'] || source.commit !== commit || source.version !== pkg.version)
            throw Error('LINUX_BUILD_SOURCE');
    }
    const assets = {}, sizes = {};
    for (const name of LINUX_BUILD_ASSETS) {
        const value = await io.hashAsset('release/' + name);
        if (!value || Object.keys(value).sort().join(',') !== 'bytes,sha256' ||
            !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 2 * 1024 ** 3 ||
            typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw Error('LINUX_BUILD_ASSET');
        assets[name] = value.sha256; sizes[name] = value.bytes;
    }
    let validationEvidence = null;
    if (flags['validation-result']) validationEvidence = {
        bytes: await io.readSmall(flags['validation-result'], 65536), sha256: flags['validation-sha256'] };
    const record = createLinuxBuildRecord({ mode: flags.mode, version: pkg.version, commit, assets,
        archiveBytes: sizes['Diagnostic-Hub-linux-x64.tar.gz'], source, sourceRecordSHA256, validationEvidence });
    const bytes = Buffer.from(JSON.stringify(record, null, 4) + '\n');
    if (bytes.length > 65536) throw Error('LINUX_BUILD_RECORD_CAP');
    const acknowledgement = await io.writeRecord('release/linux-build-info.json', bytes);
    if (acknowledgement !== undefined) throw Error('LINUX_BUILD_WRITE_ACK');
    return record;
}
// Only explicit CLI execution selects effects. No app, child process, Git or native helper is invoked.
async function main() {
    const args = process.argv.slice(2), flags = linuxBuildArguments(args);
    if (flags.help) {
        process.stdout.write('record-linux-build.mjs [--mode=published-release|private-build] [--source-record=PATH --source-record-sha256=SHA256] [--validation-result=PATH --validation-sha256=SHA256]\n');
        return;
    }
    const fs = await import('node:fs/promises');
    const { createReadStream } = await import('node:fs');
    const readSmall = async (file, cap) => {
        const chunks = []; let bytes = 0;
        for await (const chunk of createReadStream(file, { highWaterMark: 65536 })) {
            bytes += chunk.length; if (bytes > cap) throw Error('LINUX_BUILD_RECORD_CAP'); chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    };
    await recordLinuxBuild(args, { GITHUB_SHA: process.env.GITHUB_SHA }, { readSmall,
        async hashAsset(file) {
            const digest = createHash('sha256'); let bytes = 0;
            for await (const chunk of createReadStream(file, { highWaterMark: 65536 })) {
                bytes += chunk.length; if (bytes > 2 * 1024 ** 3) throw Error('LINUX_BUILD_ASSET_CAP'); digest.update(chunk);
            }
            return { bytes, sha256: digest.digest('hex') };
        }, writeRecord: (file, bytes) => fs.writeFile(file, bytes) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    void main().catch(() => {
        process.stderr.write('Linux build metadata incomplete; any partial output remains unqualified.\n');
        process.exitCode = 1;
    });
}
