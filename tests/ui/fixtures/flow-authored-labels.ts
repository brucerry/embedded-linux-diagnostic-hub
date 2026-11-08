import {
    authoredLabels,
    authoredLabelInput,
    assertAuthoredLabelEntries,
    labelPositions,
    labelStamp,
    type AuthoredLabel,
} from '../../fixtures/flow-authored-labels';
const check = (value: unknown, message: string) => {
    if (!value) throw Error(message);
};
export type LabelMutation = 'swapped' | 'wrong' | 'missing';
function svgDocument(source: string) {
    check(source.length <= 256 * 1024, 'SVG label byte budget');
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    check(
        !doc.querySelector('parsererror') && doc.documentElement.localName === 'svg',
        'SVG label document',
    );
    return doc;
}
export function inspectAuthoredSvg(source: string) {
    const doc = svgDocument(source);
    const cards = [...doc.querySelectorAll('rect[width="300"][height="168"]')];
    check(
        cards.length === 2 &&
            cards.every(
                (r, i) =>
                    r.getAttribute('x') === String(i === 0 ? 100 : 480) &&
                    r.getAttribute('y') === '220',
            ),
        'SVG authored card geometry',
    );
    return assertAuthoredLabelEntries(
        [...doc.querySelectorAll('text[data-command]')].map((text) => ({
            ordinal: Number(text.getAttribute('data-command')),
            role: text.getAttribute('data-flow-text') ?? '',
            text: text.textContent ?? '',
        })),
    );
}
export function mutateAuthoredSvg(source: string, mutation: LabelMutation) {
    const doc = svgDocument(source),
        one = (ordinal: number, role: string) =>
            doc.querySelector(`text[data-command="${ordinal}"][data-flow-text="${role}"]`)!;
    if (mutation === 'swapped') {
        const a = one(1, 'name'),
            b = one(2, 'name'),
            old = a.textContent;
        a.textContent = b.textContent;
        b.textContent = old;
    } else if (mutation === 'wrong') one(1, 'preview').textContent = 'WRONG PAYLOAD ZZZZZ';
    else one(2, 'intent').remove();
    return new XMLSerializer().serializeToString(doc);
}
export async function exportAuthoredLabels() {
    await document.fonts.ready;
    const modelPath = new URL('/src/features/automation/flow/model.ts', location.href).href;
    const rasterPath = new URL('/src/features/automation/flow/raster.ts', location.href).href;
    const { snapshot, scene } = (await import(
        /* @vite-ignore */ modelPath
    )) as typeof import('../../../src/features/automation/flow/model');
    const { exportRaster } = (await import(
        /* @vite-ignore */ rasterPath
    )) as typeof import('../../../src/features/automation/flow/raster');
    const input = authoredLabelInput(),
        before = JSON.stringify(input),
        graph = scene(snapshot(input, true, labelStamp), labelPositions);
    const pdf = await exportRaster(graph, 'pdf', false),
        svg = await exportRaster(graph, 'svg', false);
    check(
        pdf.blob.size <= 8 * 1024 * 1024 && svg.blob.size <= 256 * 1024,
        'Authored export read budget',
    );
    check(JSON.stringify(input) === before, 'Authored input mutation');
    return {
        pdf: btoa(
            Array.from(new Uint8Array(await pdf.blob.arrayBuffer()), (b) =>
                String.fromCharCode(b),
            ).join(''),
        ),
        svg: await svg.blob.text(),
    };
}
export interface LabelImage {
    jpeg: string;
    width: number;
    height: number;
}
function inputBounds(images: LabelImage[]) {
    check(images.length >= 3 && images.length <= 5, 'PDF authored page budget');
    check(
        images.reduce((n, i) => n + i.jpeg.length, 0) <= 12 * 1024 * 1024,
        'PDF authored encoded budget',
    );
    check(
        images.every((i) => i.width === 1684 && i.height === 1190),
        'PDF authored dimensions',
    );
}
async function decode(canvas: HTMLCanvasElement, value: LabelImage) {
    const image = new Image();
    image.src = 'data:image/jpeg;base64,' + value.jpeg;
    try {
        await image.decode();
        check(
            image.naturalWidth === 1684 && image.naturalHeight === 1190,
            'PDF authored decoded dimensions',
        );
        canvas.getContext('2d')!.drawImage(image, 0, 0);
    } finally {
        image.src = '';
    }
}
function drawLiteral(ctx: CanvasRenderingContext2D, label: Readonly<AuthoredLabel>, text: string) {
    ctx.font = `${label.size}px system-ui, sans-serif`;
    ctx.fillStyle = label.color;
    const m = ctx.measureText(text);
    ctx.fillText(
        text,
        label.x + 2 + Math.max(0, m.actualBoundingBoxLeft),
        label.top + Math.max(label.size, m.actualBoundingBoxAscent) + 2,
    );
}
export async function inspectAuthoredPdf(images: LabelImage[]) {
    inputBounds(images);
    await document.fonts.ready;
    const actual = document.createElement('canvas'),
        reference = document.createElement('canvas');
    actual.width = reference.width = 1684;
    actual.height = reference.height = 1190;
    const ctx = actual.getContext('2d', { willReadFrequently: true })!,
        ref = reference.getContext('2d', { willReadFrequently: true })!;
    const background = [41, 53, 65],
        reports: { page: number; labels: number; maxInkError: number }[] = [];
    try {
        for (const page of [0, 1]) {
            await decode(actual, images[page]);
            ref.setTransform(1, 0, 0, 1, 0, 0);
            ref.fillStyle = '#293541';
            ref.fillRect(0, 0, 1684, 1190);
            // Authored 1000x488 geometry: overview and the sole readable tile use0.778.
            ref.setTransform(1.556, 0, 0, 1.556, 64, 130);
            for (const label of authoredLabels) drawLiteral(ref, label, label.text);
            let maxInkError = 0;
            for (const label of authoredLabels) {
                const x = Math.floor(64 + label.x * 1.556),
                    y = Math.floor(130 + label.top * 1.556),
                    width = Math.ceil(272 * 1.556),
                    height = Math.ceil(label.height * 1.556);
                check(
                    x >= 0 && y >= 0 && x + width <= 1684 && y + height <= 1190,
                    'PDF authored reference bounds',
                );
                const expected = ref.getImageData(x, y, width, height).data,
                    observed = ctx.getImageData(x, y, width, height).data;
                let ink = 0,
                    error = 0;
                for (let p = 0; p < expected.length; p += 4) {
                    let a = 0,
                        b = 0;
                    for (let c = 0; c < 3; c++) {
                        a += Math.abs(expected[p + c] - background[c]);
                        b += Math.abs(observed[p + c] - background[c]);
                    }
                    if (Math.max(a, b) < 45) continue;
                    ink += Math.max(a, b);
                    for (let c = 0; c < 3; c++)
                        error += Math.abs(expected[p + c] - observed[p + c]);
                }
                const id = `PDF ${page === 0 ? 'overview' : 'graph'} label ${label.ordinal}.${label.role}`;
                check(ink > 1000, id + ' meaningful ink');
                const ratio = error / ink;
                check(ratio <= 0.22, id + ` ink error ${ratio.toFixed(4)} >0.22`);
                maxInkError = Math.max(maxInkError, ratio);
            }
            reports.push({ page: page + 1, labels: 10, maxInkError });
        }
        return {
            pages: images.length,
            checkedPages: reports,
            literalLabels: 10,
            comparisons: 20,
            reference: 'authored literals and fixed geometry; no product SVG used',
        };
    } finally {
        actual.width = reference.width = 1;
        actual.height = reference.height = 1;
    }
}
export async function mutateAuthoredPdf(images: LabelImage[], mutation: LabelMutation) {
    inputBounds(images);
    await document.fonts.ready;
    const canvas = document.createElement('canvas');
    canvas.width = 1684;
    canvas.height = 1190;
    try {
        await decode(canvas, images[1]);
        const ctx = canvas.getContext('2d')!;
        ctx.setTransform(1.556, 0, 0, 1.556, 64, 130);
        const replace = (ordinal: number, role: string, text: string | undefined) => {
            const label = authoredLabels.find((x) => x.ordinal === ordinal && x.role === role)!;
            ctx.fillStyle = '#293541';
            ctx.fillRect(label.x, label.top, 272, label.height);
            if (text !== undefined) drawLiteral(ctx, label, text);
        };
        if (mutation === 'swapped') {
            replace(1, 'name', '2. Bravo <skip>');
            replace(2, 'name', '1. Alpha & link');
        } else if (mutation === 'wrong') replace(1, 'preview', 'WRONG PAYLOAD ZZZZZ');
        else replace(2, 'intent', undefined);
        const changed = images.slice();
        changed[1] = { ...images[1], jpeg: canvas.toDataURL('image/jpeg', 1.0).split(',')[1] };
        return changed;
    } finally {
        canvas.width = canvas.height = 1;
    }
}
