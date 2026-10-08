// Fixed destinations; the native bridge never opens arbitrary renderer URLs.
import metadata from '../package.json';
export const APP_VERSION = metadata.version;
export const REPOSITORY_URL = 'https://github.com/brucerry/embedded-linux-diagnostic-hub';

export const RELEASES_URL = `${REPOSITORY_URL}/releases`;
