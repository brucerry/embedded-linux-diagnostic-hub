import {
    installBrowserResourceLedger,
    type BrowserResourceLedger,
} from './memory-product-browser-ledger';
declare global {
    interface Window {
        memoryProductLedger: BrowserResourceLedger;
    }
}
if (window.memoryProductLedger) throw Error('Product browser ledger already installed.');
window.memoryProductLedger = installBrowserResourceLedger(globalThis);
