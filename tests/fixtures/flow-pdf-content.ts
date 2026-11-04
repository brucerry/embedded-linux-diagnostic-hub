import assert from 'node:assert/strict';

// A test reader for imagePdf's deliberately small PDF subset, not a general PDF
// validator or a JPEG decoder. Binary streams are sliced by byte offsets/lengths;
// delimiter-looking bytes inside an image must not affect object parsing.
export function inspectFlowPdf(input: Uint8Array) {
    assert(input.byteLength > 0 && input.byteLength <= 8 * 1024 * 1024, 'PDF read budget');
    const bytes = Buffer.from(input), text = bytes.toString('latin1');
    assert(text.startsWith('%PDF-1.4\n'), 'PDF header');
    const end = /startxref\n(\d+)\n%%EOF\n$/.exec(text);
    assert(end, 'PDF final trailer');
    const start = Number(end[1]);
    assert(Number.isSafeInteger(start) && start > 0 && start < bytes.length, 'PDF xref offset');
    const xref = /^xref\n0 (\d+)\n0000000000 65535 f \n/.exec(text.slice(start));
    assert(xref, 'PDF xref table');
    const count = Number(xref[1]);
    assert(count >= 6 && count <= 3 + 128 * 3 && count % 3 === 0, 'PDF object count');
    let cursor = start + xref[0].length;
    const offsets = [0];
    for (let id = 1; id < count; id++) {
        const entry = /^(\d{10}) 00000 n \n/.exec(text.slice(cursor));
        assert(entry, 'PDF xref entry');
        const offset = Number(entry[1]);
        assert(offset > offsets[id - 1] && offset < start, 'PDF object offset order');
        offsets.push(offset);
        cursor += entry[0].length;
    }
    assert.equal(text.slice(cursor), `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`, 'PDF trailer identity');
    const objects = new Map<number, Buffer>();
    for (let id = 1; id < count; id++) {
        const block = bytes.subarray(offsets[id], offsets[id + 1] ?? start);
        const prefix = Buffer.from(`${id} 0 obj\n`), suffix = Buffer.from('\nendobj\n');
        assert(block.subarray(0, prefix.length).equals(prefix), 'PDF object identity');
        assert(block.subarray(-suffix.length).equals(suffix), 'PDF object boundary');
        objects.set(id, block.subarray(prefix.length, -suffix.length));
    }
    const object = (id: number) => {
        const value = objects.get(id);
        assert(value, 'PDF referenced object missing');
        return value;
    };
    const stream = (id: number) => {
        const block = object(id), marker = Buffer.from('\nstream\n');
        const split = block.indexOf(marker);
        assert(split > 0, 'PDF stream dictionary');
        const dictionary = block.subarray(0, split).toString('ascii');
        const length = /\/Length (\d+) >>$/.exec(dictionary);
        assert(length, 'PDF stream length');
        const size = Number(length[1]), begin = split + marker.length, finish = begin + size;
        assert(Number.isSafeInteger(size) && size > 0, 'PDF positive stream length');
        assert.equal(block.length, finish + '\nendstream'.length, 'PDF exact stream length');
        assert.equal(block.subarray(finish).toString(), '\nendstream', 'PDF stream boundary');
        return { dictionary, data: block.subarray(begin, finish) };
    };
    assert.equal(object(1).toString(), '<< /Type /Catalog /Pages 2 0 R >>', 'PDF catalog');
    const pages = (count - 3) / 3;
    const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 3} 0 R`).join(' ');
    assert.equal(object(2).toString(), `<< /Type /Pages /Count ${pages} /Kids [${kids}] >>`, 'PDF page tree');
    const images = [];
    for (let i = 0; i < pages; i++) {
        const page = 3 + i * 3;
        assert.equal(object(page).toString(), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /XObject << /Im0 ${page + 1} 0 R >> >> /Contents ${page + 2} 0 R >>`, 'PDF page references and bounds');
        const image = stream(page + 1);
        const shape = /^<< \/Type \/XObject \/Subtype \/Image \/Width (\d+) \/Height (\d+) \/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/DCTDecode \/Length \d+ >>$/.exec(image.dictionary);
        assert(shape, 'PDF RGB JPEG image dictionary');
        const width = Number(shape[1]), height = Number(shape[2]);
        assert(width > 0 && height > 0 && width * height <= 16_000_000, 'PDF image dimensions');
        inspectJpegEnvelope(image.data, width, height);
        const content = stream(page + 2);
        assert.equal(content.dictionary, `<< /Length ${content.data.length} >>`, 'PDF content dictionary');
        assert.equal(content.data.toString(), 'q\n842 0 0 595 0 0 cm\n/Im0 Do\nQ', 'PDF image painting instructions');
        images.push({ width, height, bytes: image.data.length });
    }
    return { pages, objects: count - 1, images };
}

// Check the JPEG header's frame dimensions and a bounded scan envelope. Entropy
// coefficients, colour interpretation and rendered label/pixel fidelity remain
// outside this source-only check and still need a real decoder/viewer.
function inspectJpegEnvelope(bytes: Buffer, width: number, height: number) {
    assert(bytes[0] === 0xff && bytes[1] === 0xd8, 'JPEG start');
    assert(bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9, 'JPEG end');
    let cursor = 2, frame = false;
    while (cursor < bytes.length - 2) {
        assert.equal(bytes[cursor++], 0xff, 'JPEG header marker');
        while (bytes[cursor] === 0xff) cursor++;
        const marker = bytes[cursor++];
        assert(marker !== 0 && marker !== 0xd8 && marker !== 0xd9, 'JPEG segment marker');
        assert(cursor + 2 <= bytes.length - 2, 'JPEG segment size field');
        const length = bytes.readUInt16BE(cursor), finish = cursor + length;
        assert(length >= 2 && finish <= bytes.length - 2, 'JPEG segment extent');
        if ([0xc0, 0xc1, 0xc2].includes(marker)) {
            assert(!frame && length === 17, 'JPEG single three-component frame');
            assert.equal(bytes[cursor + 2], 8, 'JPEG sample precision');
            assert.equal(bytes.readUInt16BE(cursor + 3), height, 'JPEG height matches PDF');
            assert.equal(bytes.readUInt16BE(cursor + 5), width, 'JPEG width matches PDF');
            assert.equal(bytes[cursor + 7], 3, 'JPEG component count');
            frame = true;
        }
        if (marker === 0xda) {
            assert(frame && length >= 6 && finish < bytes.length - 2, 'JPEG scan follows frame and has data');
            return;
        }
        cursor = finish;
    }
    assert.fail('JPEG image lacks scan data');
}
