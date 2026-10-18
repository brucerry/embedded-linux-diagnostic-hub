import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closeEntries, writeAll } from './product-collector-evidence.mjs';
/** Bounded cooperative writer only. It does NOT establish a bound for Chromium/SQLite or other native writers. */
export function growthCanary(
    root,
    ledger,
    {
        check,
        cleanupCheck = check,
        observe,
        io = fs,
        clock = () => Number(process.hrtime.bigint() / 1000000n),
    } = {},
) {
    const reservation = ledger.reserve({
        writer: 'finite-growth-canary',
        bytes: 16 * 1024 ** 2,
        files: 64,
        reviewedPrewriteBound: true,
    });
    const handles = [],
        files = [];
    let written = 0,
        peak = 0,
        maxOvershoot = 0,
        failure = null,
        allClosed = false;
    let observerMs = 0,
        maxGapMs = 0,
        lastObserved = clock();
    const buffer = Buffer.alloc(262144, 0x61);
    try {
        check();
        assert.deepEqual(io.readdirSync(root), []);
        for (let i = 0; i < 64; i++) {
            check();
            const file = path.join(root, 'canary-' + i + '.bin');
            const fd = io.openSync(file, 'wx', 0o600),
                entry = { fd, errors: [], attempted: false, synced: false, closed: false };
            handles.push(entry);
            files.push(file);
            writeAll(fd, buffer, io);
            written += buffer.length;
            const closed = closeEntries([entry], io);
            assert(closed.complete, 'Canary descriptor closure uncertain.');
            const scanStart = clock();
            const current = files.reduce((n, p) => {
                const s = io.lstatSync(p);
                assert(s.isFile() && !s.isSymbolicLink() && s.nlink === 1);
                return n + s.size;
            }, 0);
            peak = Math.max(peak, current);
            maxOvershoot = Math.max(maxOvershoot, buffer.length);
            const scanMs = clock() - scanStart,
                gapMs = clock() - lastObserved;
            observerMs += scanMs;
            maxGapMs = Math.max(maxGapMs, gapMs);
            lastObserved = clock();
            observe(ledger.observe({ bytes: current, files: files.length, scanMs, gapMs }));
        }
    } catch (e) {
        failure = String(e);
    }
    const closure = closeEntries(handles, io);
    allClosed = handles.every((e) => e.closed);
    if (allClosed)
        try {
            cleanupCheck();
            for (const file of files) io.unlinkSync(file);
        } catch (e) {
            failure ??= String(e);
        }
    return {
        reservation,
        written,
        peak,
        observerMs,
        maxGapMs,
        conservativePeakPlusBurstBytes: peak + maxOvershoot,
        maxAdmittedSingleWriteBytes: maxOvershoot,
        profilePlusCanarySlack: 246 * 1024 ** 2 - reservation.bytes,
        closure,
        allClosed,
        cleaned: allClosed && files.every((p) => !io.existsSync(p)),
        failure,
        nativeWriterOvershootQualified: false,
        scope: 'cooperative canary only; native writer gate remains blocked',
    };
}
