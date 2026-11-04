import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateHostBinding } from './memory-product-host-ownership';

/** Reviewed current source contracts; this is not a runtime or loaded-byte attestation. */
export const nativeMainSourcePins: Record<string, string> = Object.freeze({
    "electron/main.ts": "5c2fb3610fdf1801e521be69cc726572df82d4357c03a2c488695783855b78ef",
    "electron/capture-host.ts": "a939da5ab4819be7306427db68c34bfe6b07593f73bdc056b2a3661ac227b2e3",
    "electron/capture-store.ts": "6e96a463141882f7f292a72352b80ddcb5be64d64915a98c1fef482903097721",
    "shared/capture-rpc.ts": "255f7434b7bbadda2401f3245902fe2ac40add0dab610f7d154363e655fe9949",
    "electron/console-service.ts": "66db1bb327e50423aad6027fb2cd1de76caa193fec3811f4154bbae1222d2f2a",
    "electron/automation-activity.ts": "1a3e969e9545476ca0157c6504e9df072ff1240e68e512ef4fc6370aa573d95c",
    "electron/update-ownership.ts": "e019015944ac47575349ca9ea4428ab209885f29fe0866040aa711381492e6f8",
    "electron/report-export.ts": "73243675423cf9e0f38ac575df7dbfaf46bb315a42ac4670a350886575578bc5",
    "shared/quit-cleanup.ts": "4561dc9bf71cae68807ff65524bb301b295839bb07825e3aad31fe115fdc8ee7",
    "electron/connection-attempts.ts": "ef279a81801d736dabba39df04e09b08e81dc08d7413a95f8f64ce2ff1bb9b30",
    "electron/host-verification.ts": "2680a5d558f53eadfc5e680f2388d05b28349bf14ea1557171aef1fe4de23ff0",
    "backend/ssh/monitor.ts": "668d48ff0a8e817a3f419b5b8916059dafe6699abadb227985a24c38aec8aaac",
    "backend/ssh/session.ts": "e62a116121347e2a1eec0415441bfee3bb908ad5e7b9819c6c7befba8f0bba5f",
    "backend/ssh/stream-host.ts": "224f9914811347f2b01de205b7c8d2664fdb5596a2524a38047109d1f7043e5c"
});
const mainProbe = String.raw`
    let __memoryNativeReadWrapped=false;
    let __memoryNativeReport:any=null,__memoryNativeReportOrdinal=0;
    const __memoryNativeDownloads={ready:false,error:null as string|null,next:0,records:[] as any[],navigations:[] as string[]};
    (globalThis as any).__memoryNativeDownloads=__memoryNativeDownloads;
    app.whenReady().then(()=>{try{
    session.defaultSession.on('will-download',(_event,item)=>{
        const records=__memoryNativeDownloads.records;
        if(records.length>=16)throw Error('Private native download receipt bound exceeded.');
        const directory=process.env.HUB_PRODUCT_NATIVE_DOWNLOADS;
        if(!directory||!path.isAbsolute(directory))throw Error('Private native download destination missing.');
        const name=item.getFilename();
        const ordinal=__memoryNativeDownloads.next++;
        const row={ordinal,file:path.join(directory,ordinal+'-'+name.replace(/[^a-zA-Z0-9._-]/g,'_')),name,state:'started',receivedBytes:0};
        records.push(row);item.setSavePath(row.file);
        item.once('done',(_done,state)=>{row.state=state;row.receivedBytes=item.getReceivedBytes();});
    });
    __memoryNativeDownloads.ready=true;
    }catch(error){__memoryNativeDownloads.error=String(error);}});
    app.on('web-contents-created',(_event,contents)=>contents.on('will-navigate',(_navigation,url)=>{if(__memoryNativeDownloads.navigations.length<16)__memoryNativeDownloads.navigations.push(url.slice(0,512));}));
    let __memoryCaptureSeen=false;
    const __memoryNativeSnapshot=()=>{
        const host=(globalThis as any).__memoryProductCapture;
        if(host!==undefined)__memoryCaptureSeen=true;
        const sshSnapshot=ssh.ownershipSnapshot;
        const consoleObservation=__memoryObserveConsole(consoleService);
        return {ssh:sshSnapshot,streamOwnership:__memoryObserveHost(sshSnapshot,__memoryHostBinding,'native'),
            sshHasResources:ssh.hasResources,console:consoleObservation.snapshot,consoleHasResources:consoleObservation.hasResources,
            capture:__memoryObserveCapture(host),activity:__memoryObserveActivity((globalThis as any).__memoryProductActivity),
            mainOwnership:__memoryObserveMain({quit,captureOpening:__memoryCaptureOpening.pending,captureOpeningUnconfirmed:__memoryCaptureOpening.unconfirmed,collectionTask,
                connectionAttempts,hostVerification,reportExports,updateOwnership,ownsProfile}),
            memory:process.memoryUsage(),versions:process.versions};
    };
    (globalThis as any).__memoryNativeQualification={snapshot:__memoryNativeSnapshot,
    prepareReport(file:string){const host=(globalThis as any).__memoryProductCapture;if(!host||__memoryNativeReport)throw Error('Native report boundary unavailable/busy.');const directory=process.env.HUB_PRODUCT_NATIVE_DOWNLOADS;if(!directory||path.dirname(file)!==directory)throw Error('Native test destination escaped its private directory.');const original=host.destination;__memoryNativeReport={file,original,invoked:false,format:null};host.destination=async(format:any)=>{if(__memoryNativeReport.invoked)throw Error('Duplicate native Save destination.');__memoryNativeReport.invoked=true;__memoryNativeReport.format=format;return file;};},
    reportStatus(){return __memoryNativeReport?{file:__memoryNativeReport.file,invoked:__memoryNativeReport.invoked,format:__memoryNativeReport.format}:null;},
    finishReport(){const host=(globalThis as any).__memoryProductCapture;if(!host||!__memoryNativeReport||host.exports.size)throw Error('Native report not joined.');const {original,...receipt}=__memoryNativeReport;host.destination=original;__memoryNativeReport=null;return receipt;},
    readFault:{
        arm(action:any){const host=(globalThis as any).__memoryProductCapture;if(!host?.store)throw Error('Actual native capture store missing.');if(!__memoryNativeReadWrapped){__memoryNativeReadFault.wrap(host.store);__memoryNativeReadWrapped=true;}__memoryNativeReadFault.arm(action);},
        status:()=>__memoryNativeReadFault.status(),release:()=>__memoryNativeReadFault.release(),clear:()=>__memoryNativeReadFault.clear()
    }};
    const __memoryNativeQuit=__memoryCreateQuitObserver({
        phase:()=>quit.phase,
        snapshot:()=>({at:new Date().toISOString(),snapshot:__memoryNativeSnapshot(),downloads:__memoryNativeDownloads.records}),
        validate:(value:any)=>{
            if(__memoryNativeDownloads.error)throw Error('Native download observer failed.');
            __memoryAssertShutdown(value.snapshot,{captureExpected:__memoryCaptureSeen,downloads:value.downloads});
        },
        write:(value:any)=>{const file=process.env.HUB_PRODUCT_NATIVE_EXIT;if(!file)throw Error('Native exit receipt path missing.');__memoryWriteSnapshot(file,JSON.stringify(value));},
        schedule:(callback:()=>void)=>{setImmediate(callback);},requestQuit:()=>{app.quit();}
    });
    (globalThis as any).__memoryNativeQuit=__memoryNativeQuit;
    app.on('will-quit',__memoryNativeQuit.observeWillQuit);
`;
export async function verifyNativeMainSources(root: string,
    read: (file: string) => Promise<string> = file => fs.readFile(file, 'utf8')) {
    if (!path.isAbsolute(root)) throw Error('Explicit native source root required.');
    for (const [file, expected] of Object.entries(nativeMainSourcePins)) {
        const source = await read(path.join(root, file));
        if (createHash('sha256').update(source).digest('hex') !== expected)
            throw Error('Native main dependency preimage changed: ' + file);
    }
}
export function transformNativeOwnedSource(source: string, file: string, binding: unknown) {
    const expected = nativeMainSourcePins[file];
    if (!expected || createHash('sha256').update(source).digest('hex') !== expected)
        throw Error('Native probe preimage changed or unsupported: ' + file);
    if (file === 'electron/main.ts') {
        const accepted = validateHostBinding(binding, 'native');
        const needle = "    app.on('window-all-closed', () => app.quit());";
        const begin = '        return (captureHostPromise ??= NativeCaptureHost.open(';
        const end = '        }));\n    };\n    const resetCaptureRenderer';
        for (const boundary of [needle, begin, end])
            if (source.split(boundary).length !== 2) throw Error('Native main observation boundary changed.');
        const imports = "import {writeFileSync as __memoryWriteSnapshot} from 'node:fs';\n" +
            "import {workerReadFault as __memoryNativeReadFault} from '../tests/fixtures/memory-product-worker-faults';\n" +
            "import {observeProductHost as __memoryObserveHost} from '../tests/fixtures/memory-product-host-ownership';\n" +
            "import {observeNativeMain as __memoryObserveMain,observeNativeCapture as __memoryObserveCapture,observeNativeActivity as __memoryObserveActivity,observeNativeConsole as __memoryObserveConsole,createNativeCaptureOpening as __memoryCreateCaptureOpening} from '../tests/fixtures/memory-product-native-main-state';\n" +
            "import {createNativeQuitObserver as __memoryCreateQuitObserver} from '../tests/fixtures/memory-product-native-quit-observer';\n" +
            "import {assertProductNativeShutdown as __memoryAssertShutdown} from '../tests/fixtures/memory-product-native-verdict';\n" +
            "const __memoryHostBinding=" + JSON.stringify(accepted) + ";\nconst __memoryCaptureOpening=__memoryCreateCaptureOpening();\n";
        return { code: imports + source.replace(needle, mainProbe + '\n' + needle)
            .replace(begin, '        return (captureHostPromise ??= __memoryCaptureOpening.run(() => NativeCaptureHost.open(')
            .replace(end, '        })));\n    };\n    const resetCaptureRenderer'),
            importPrefix: imports, observation: mainProbe };
    }
    const constructors: Record<string, [string, string]> = {
        'electron/capture-host.ts': ['NativeCaptureHost', '__memoryProductCapture'],
        'electron/automation-activity.ts': ['AutomationActivity', '__memoryProductActivity'],
    };
    const target = constructors[file];
    if (!target) return { code: source, importPrefix: '', observation: '' };
    const needle = 'export class ' + target[0] + ' {';
    if (source.split(needle).length !== 2) throw Error('Native constructor boundary changed.');
    const observation = '\n private readonly __qualification = ((globalThis as any).' + target[1] + '=this);';
    return { code: source.replace(needle, needle + observation), importPrefix: '', observation };
}
