import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { imagePdf } from '../src/features/automation/flow/pdf';
import {
    inspectFlowPdf,
    inspectFlowPdfExport,
    readFlowPdfImages,
} from './fixtures/flow-pdf-content';

// Synthetic JPEG header/scan envelopes, deliberately not decoded images. This
// exercises PDF framing and byte preservation without canvas/browser/codec use.
const jpeg = (width = 2, height = 3, marker = 0xc0) =>
    Buffer.from([
        0xff,
        0xd8,
        0xff,
        marker,
        0,
        17,
        8,
        height >> 8,
        height & 255,
        width >> 8,
        width & 255,
        3,
        1,
        0x11,
        0,
        2,
        0x11,
        1,
        3,
        0x11,
        1,
        0xff,
        0xda,
        0,
        12,
        3,
        1,
        0,
        2,
        0x11,
        3,
        0x11,
        0,
        63,
        0,
        ...Buffer.from('\nendstream\nendobj\nxref\n'),
        0xff,
        0,
        0x42,
        0xff,
        0xd9,
    ]);
const pdf = (bytes = jpeg(), width = 2, height = 3) =>
    Buffer.from(imagePdf([{ bytes, width, height }]));
function replace(bytes: Buffer, before: string, after: string) {
    assert.equal(Buffer.byteLength(before), Buffer.byteLength(after));
    const index = bytes.indexOf(before);
    assert(index >= 0, 'Mutation target must exist');
    const copy = Buffer.from(bytes);
    copy.write(after, index, 'ascii');
    return copy;
}

test('PDF reader checks actual serializer multipage references, exact binary streams and JPEG frames', () => {
    const images = [
        { bytes: jpeg(), width: 2, height: 3 },
        { bytes: jpeg(19, 11, 0xc2), width: 19, height: 11 },
    ];
    const bytes = imagePdf(images),
        before = Buffer.from(bytes);
    assert.deepEqual(inspectFlowPdf(bytes), {
        pages: 2,
        objects: 8,
        images: images.map((i) => ({
            width: i.width,
            height: i.height,
            bytes: i.bytes.length,
            sha256: createHash('sha256').update(i.bytes).digest('hex'),
        })),
    });
    assert(Buffer.from(bytes).equals(before), 'Verification cannot mutate the export');
});

test('PDF reader rejects the previous header-only assertion false positive', () => {
    assert.throws(() => inspectFlowPdf(Buffer.from('%PDF-1.4\n')), /final trailer/);
    assert.throws(() => inspectFlowPdf(pdf().subarray(0, -6)), /final trailer/);
});

test('PDF reader rejects wrong startxref and object offsets', () => {
    const bytes = pdf(),
        text = bytes.toString('latin1');
    const offset = /startxref\n(\d+)/.exec(text)![1];
    assert.throws(
        () =>
            inspectFlowPdf(
                replace(bytes, `startxref\n${offset}`, `startxref\n${'0'.repeat(offset.length)}`),
            ),
        /xref offset/,
    );
    const entry = /\d{10} 00000 n /.exec(text)![0];
    assert.throws(
        () => inspectFlowPdf(replace(bytes, entry, '0000000001 00000 n ')),
        /object identity/,
    );
});

test('PDF reader rejects stale page count, broken child references and page resource identity', () => {
    const bytes = pdf();
    for (const [before, after] of [
        ['/Count 1', '/Count 2'],
        ['/Kids [3 0 R]', '/Kids [4 0 R]'],
        ['/Im0 4 0 R', '/Im0 5 0 R'],
    ])
        assert.throws(
            () => inspectFlowPdf(replace(bytes, before, after)),
            /page tree|page references/,
        );
});

test('PDF reader rejects stream-length drift and corrupted painting instructions', () => {
    const bytes = pdf(),
        size = jpeg().length;
    assert.throws(
        () => inspectFlowPdf(replace(bytes, `/Length ${size}`, `/Length ${size + 1}`)),
        /stream length/,
    );
    assert.throws(
        () => inspectFlowPdf(replace(bytes, '/Im0 Do', '/Im1 Do')),
        /painting instructions/,
    );
});

test('PDF reader rejects mismatched JPEG dimensions and missing or malformed scan envelopes', () => {
    assert.throws(() => inspectFlowPdf(pdf(jpeg(4, 3))), /width matches PDF/);
    assert.throws(() => inspectFlowPdf(pdf(jpeg(2, 4))), /height matches PDF/);
    assert.throws(() => inspectFlowPdf(pdf(Buffer.from([255, 216, 255, 217]))), /lacks scan/);
    assert.throws(() => inspectFlowPdf(pdf(jpeg().subarray(0, -2))), /JPEG end/);
    const invalid = jpeg();
    invalid[4] = 0xff;
    assert.throws(() => inspectFlowPdf(pdf(invalid)), /segment extent/);
});

test('PDF reader admits the serializer page maximum and enforces its existing file read budget', () => {
    const image = { bytes: jpeg(), width: 2, height: 3 };
    assert.equal(inspectFlowPdf(imagePdf(Array.from({ length: 128 }, () => image))).pages, 128);
    assert.throws(() => inspectFlowPdf(new Uint8Array(8 * 1024 * 1024 + 1)), /read budget/);
});

test('PDF reader rejects same-length high-bit dictionary mutations without ASCII normalization', () => {
    for (const token of ['/Width ', '/Height ', '/Length ']) {
        const bytes = pdf(),
            at = bytes.indexOf(token);
        assert(at >= 0);
        assert.equal(bytes[at], 0x2f);
        const before = Buffer.from(bytes);
        bytes[at] = 0xaf;
        assert.equal(bytes.length, before.length, 'Offsets and all object lengths stay unchanged');
        assert.throws(() => inspectFlowPdf(bytes), /dictionary contains non-ASCII/);
    }
});

test('PDF export check rejects three duplicate page images that pass structural count/dimension checks', () => {
    const image = { bytes: jpeg(1684, 1190), width: 1684, height: 1190 };
    const bytes = imagePdf([image, image, image]);
    const structural = inspectFlowPdf(bytes);
    assert.equal(structural.pages, 3);
    assert(structural.images.every((i) => i.width === 1684 && i.height === 1190));
    assert.throws(() => inspectFlowPdfExport(bytes), /duplicate page image payloads/);
});

test('PDF export check accepts distinct envelopes but does not classify their content roles', () => {
    const images = [0xc0, 0xc1, 0xc2].map((marker) => ({
        bytes: jpeg(1684, 1190, marker),
        width: 1684,
        height: 1190,
    }));
    const result = inspectFlowPdfExport(imagePdf(images));
    assert.equal(result.pages, 3);
    assert.equal(new Set(result.images.map((i) => i.sha256)).size, 3);
    assert(!('roles' in result), 'Synthetic distinct envelopes are not semantic-page evidence');
    assert.throws(() => inspectFlowPdfExport(imagePdf(images.slice(0, 2))), /at least three/);
    assert.throws(
        () =>
            inspectFlowPdfExport(
                imagePdf(images.map((i) => ({ ...i, bytes: jpeg(), width: 2, height: 3 }))),
            ),
        /canvas width/,
    );
});

test('PDF decoder inputs preserve page order, exact stream bytes and input ownership', () => {
    const source = [jpeg(1684, 1190), jpeg(1684, 1190, 0xc2)];
    const bytes = Buffer.from(
        imagePdf(source.map((data) => ({ bytes: data, width: 1684, height: 1190 }))),
    );
    const before = Buffer.from(bytes);
    const images = readFlowPdfImages(bytes);
    assert.deepEqual(
        images.map((image) => image.data),
        source,
    );
    images[0].data.fill(0);
    assert(bytes.equals(before), 'Decoded input copies cannot mutate the PDF');
    assert.throws(() => readFlowPdfImages(bytes.subarray(0, -6)), /final trailer/);
});
