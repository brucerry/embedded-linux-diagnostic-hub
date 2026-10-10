import './genie.css';
import { genieStrips } from './genie-geometry';
import type { GenieBridge } from './genie-contract';
declare global {
    interface Window {
        genie: GenieBridge;
    }
}

// Original strip renderer inspired by UI Layouts' Mac Genie example. No upstream code is copied.
// https://www.ui-layouts.com/components/mac-genie
async function render() {
    const bridge = window.genie;
    let payload = await bridge.payload();
    if (!payload) return;
    const canvas = document.querySelector('canvas')!;
    const context = canvas.getContext('2d')!;
    const image = new Image();
    image.src = payload.image;
    await image.decode();
    canvas.width = Math.ceil(payload.bounds.width * devicePixelRatio);
    canvas.height = Math.ceil(payload.bounds.height * devicePixelRatio);
    context.scale(devicePixelRatio, devicePixelRatio);
    let frame = 0;
    const release = () => {
        cancelAnimationFrame(frame);
        image.src = '';
        payload = null;
        canvas.width = canvas.height = 0;
    };
    window.addEventListener('pagehide', release, { once: true });
    function draw(progress: number) {
        if (!payload) return;
        context.clearRect(0, 0, payload.bounds.width, payload.bounds.height);
        if (progress >= 1) return;
        for (const strip of genieStrips(payload, image.width, image.height, progress)) {
            const s = strip.source,
                d = strip.destination;
            context.drawImage(image, s.x, s.y, s.width, s.height, d.x, d.y, d.width, d.height);
        }
    }
    draw(payload.direction === 'out' ? 0 : 1);
    if (!(await bridge.ready())) return release();
    const direction = payload.direction;
    const start = performance.now();
    function animate(now: number) {
        const elapsed = Math.min(1, (now - start) / 500);
        draw(direction === 'out' ? elapsed : 1 - elapsed);
        if (elapsed < 1) frame = requestAnimationFrame(animate);
        else void bridge.done().finally(release);
    }
    frame = requestAnimationFrame(animate);
}
// Preparation failures are recovered by the main-process deadline, even if this renderer dies.
void render().catch(() => {});
