/// <reference lib="webworker" />
import { exportRaster } from './raster';
import type { FlowExportFormat, Scene } from './types';
const worker = self as unknown as DedicatedWorkerGlobalScope;
worker.onmessage = async (
    event: MessageEvent<{ scene: Scene; format: FlowExportFormat; downscale: boolean }>,
) => {
    const { scene, format, downscale } = event.data;
    if (typeof OffscreenCanvas === 'undefined') {
        worker.postMessage({ needsCanvas: true });
        return;
    }
    try {
        worker.postMessage({
            ...(await exportRaster(scene, format, downscale, {
                progress: (progress) => worker.postMessage({ progress }),
            })),
        });
    } catch (error) {
        worker.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
};
