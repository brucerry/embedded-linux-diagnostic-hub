/** Explicit current-source entry for private observers. Historical APIs keep their old defaults.
 * These functions observe models or verify source bytes; none grants runtime/release admission.
 */
import * as host from './memory-product-host-ownership';
import * as source from './memory-product-host-source';
import * as native from './memory-product-native-main-transform';
import * as state from './memory-product-native-main-state';
import { nativeObserverBuildPlugin as plugin } from './memory-product-native-build-plugin';
import { assertProductNativeShutdown as shutdown } from './memory-product-native-verdict';
import { currentObserverSource, observerMainPreimage } from './memory-product-source-profile';
const profile = 'current-e9bb9bc' as const;
export { currentObserverSource };
export type { HostRealm, HostSourceBinding } from './memory-product-host-ownership';
export const nativeMainSourcePins = native.nativeMainPins(profile);
export const nativeMainPreimage = observerMainPreimage(profile);
export const hostPins = (realm: host.HostRealm) => host.hostPins(realm, profile);
export const validateHostBinding = (value: unknown, realm: host.HostRealm) =>
    host.validateHostBinding(value, realm, profile);
export const observeHostStreams = host.observeHostStreams;
export const observeProductHost = (value: unknown, binding: unknown, realm: host.HostRealm) =>
    host.observeProductHost(value, binding, realm, profile);
export const verifyProductHostObservation = (
    value: unknown,
    actual: unknown,
    realm: host.HostRealm,
) => host.verifyProductHostObservation(value, actual, realm, profile);
export const assertHostStreamsRetired = (value: host.ProductHostObservation) =>
    host.assertHostStreamsRetired(value, profile);
export const verifyProductHostSources = (
    root: string,
    realm: host.HostRealm,
    read?: (file: string) => Promise<string>,
) => source.verifyProductHostSources(root, realm, read, profile);
export const createProductHostObservation = (
    root: string,
    realm: host.HostRealm,
    read?: (file: string) => Promise<string>,
) => source.createProductHostObservation(root, realm, read, profile);
export const verifyNativeMainSources = (root: string, read?: (file: string) => Promise<string>) =>
    native.verifyNativeMainSources(root, read, profile);
export const transformNativeOwnedSource = (value: string, file: string, binding: unknown) =>
    native.transformNativeOwnedSource(value, file, binding, profile);
export const nativeObserverBuildPlugin = (root: string, binding: unknown, ssh: string) =>
    plugin(root, binding, ssh, profile);
export const observeNativeMain = (value: unknown) => state.observeNativeMain(value, profile);
export const assertNativeMainRetired = (value: unknown) =>
    state.assertNativeMainRetired(value, profile);
export const assertProductNativeShutdown = (
    value: unknown,
    options: Parameters<typeof shutdown>[1],
) => shutdown(value, options, profile);
export {
    observeNativeCapture,
    observeNativeActivity,
    observeNativeConsole,
    createNativeCaptureOpening,
    assertNativeConsoleRetired,
} from './memory-product-native-main-state';
