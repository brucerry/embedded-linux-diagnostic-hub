/** Current private renderer preparation. No browser/runtime or build is started here. */
import {
    instrumentProductSource as instrument,
    productProbePins,
    productQualificationPlugin as plugin,
} from './memory-product-instrument';
export { currentObserverSource } from './memory-product-source-profile';
const profile = 'current-e9bb9bc' as const;
export const productProbePreimages = productProbePins(profile);
export const instrumentProductSource = (source: string, id: string) =>
    instrument(source, id, profile);
export function productQualificationPlugin() {
    return { ...plugin(profile), name: 'private-current-e9bb9bc-product-probes' };
}
