import { MAX_PAGES } from './model';

export const PAPER = {
    width: 842,
    height: 595,
    margin: 32,
    tileWidth: 1000,
    tileHeight: 600,
    strideX: 700,
    strideY: 400,
} as const;
export function pdfTiles(width: number, height: number) {
    // Overlap by at least one complete card so a tile boundary never leaves a label
    // split on every page. Every card appears whole on at least one readable tile.
    const columns = Math.max(1, Math.ceil((width - PAPER.tileWidth) / PAPER.strideX) + 1),
        rows = Math.max(1, Math.ceil((height - PAPER.tileHeight) / PAPER.strideY) + 1);
    if (columns * rows + 1 > MAX_PAGES)
        throw Error('PDF exceeds 128 pages. Reset the graph layout and try again.');
    return Array.from({ length: rows * columns }, (_, i) => ({
        index: i + 1,
        column: i % columns,
        row: Math.floor(i / columns),
        columns,
        rows,
    }));
}
export interface PdfImage {
    bytes: Uint8Array;
    width: number;
    height: number;
}
// A deliberately small PDF subset: page tree + JPEG image XObjects. No scripts, links,
// embedded files, fonts, user-controlled dictionaries, metadata code or network resources.
export function imagePdf(images: readonly PdfImage[]): Uint8Array {
    if (!images.length || images.length > MAX_PAGES) throw Error('PDF requires 1–128 pages.');
    const encoder = new TextEncoder(),
        chunks: Uint8Array[] = [],
        offsets = [0];
    let length = 0;
    const append = (v: string | Uint8Array) => {
        const bytes = typeof v === 'string' ? encoder.encode(v) : v;
        length += bytes.length;
        if (length > 32 * 1024 * 1024)
            throw Error('PDF exceeds the 32 MiB export limit. Use SVG or a compact layout.');
        chunks.push(bytes);
    };
    const object = (id: number, body: string, stream?: Uint8Array) => {
        offsets[id] = length;
        append(`${id} 0 obj\n${body}`);
        if (stream) {
            append('\nstream\n');
            append(stream);
            append('\nendstream');
        }
        append('\nendobj\n');
    };
    append('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n');
    object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    object(
        2,
        `<< /Type /Pages /Count ${images.length} /Kids [${images.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] >>`,
    );
    images.forEach((image, i) => {
        if (
            !Number.isInteger(image.width) ||
            !Number.isInteger(image.height) ||
            image.width < 1 ||
            image.height < 1 ||
            image.width * image.height > 16_000_000
        )
            throw Error('Invalid PDF page image dimensions.');
        const page = 3 + i * 3;
        const content = encoder.encode(`q\n${PAPER.width} 0 0 ${PAPER.height} 0 0 cm\n/Im0 Do\nQ`);
        object(
            page,
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAPER.width} ${PAPER.height}] /Resources << /XObject << /Im0 ${page + 1} 0 R >> >> /Contents ${page + 2} 0 R >>`,
        );
        object(
            page + 1,
            `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>`,
            image.bytes,
        );
        object(page + 2, `<< /Length ${content.length} >>`, content);
    });
    const start = length,
        count = 3 + images.length * 3;
    append(`xref\n0 ${count}\n0000000000 65535 f \n`);
    for (let i = 1; i < count; i++) append(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
    append(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
    const result = new Uint8Array(length);
    let cursor = 0;
    for (const chunk of chunks) {
        result.set(chunk, cursor);
        cursor += chunk.length;
    }
    return result;
}
