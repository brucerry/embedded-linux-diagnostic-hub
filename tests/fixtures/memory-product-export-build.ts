import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const workerSHA = 'cf0b105ac581dbedc881fa3579467738aecca3772b622b4d02ee9251410c2424';
const brokerSHA = '4f9bc9db03aafc3ebc2d41fad81ec462b8fdbfe93a4d0812d2a4ee84fc30eb94';
const legacyBrokerSHA = 'a98d97f967f714c479087a1f1db811430e7e090d2e4a3d8116a7fb3ef2236066';
/** Explicit external graph pins; legacy is a pre-fix candidate, never deployed provenance. */
export interface ExportRolloutBuild {
    generation: 'candidate91-r1' | 'candidate91-r2' | 'pre-fix-candidate';
    inputs: Record<string, { bytes: number; sha256: string }>;
}
function checkedRead(file: string, rollout?: ExportRolloutBuild) {
    return fs.readFile(file, 'utf8').then((source) => {
        if (rollout) {
            const expected = rollout.inputs[path.resolve(file)];
            if (!expected || Buffer.byteLength(source) !== expected.bytes ||
                createHash('sha256').update(source).digest('hex') !== expected.sha256)
                throw Error('Unpinned rollout input: ' + file);
        }
        return source;
    });
}
// Private worker-only controls. No product result, receipt, state or clock is fabricated.
export const rolloutWorkerControl = String.raw`
const __memoryRollout = (() => {
    const events:any[]=[]; let sequence=0;
    const gates = new Map<string,any>();
    const pins:any[]=[];
    const record=(type:string,detail:unknown)=>{
        if(events.length>=256)throw Error('Rollout event bound exceeded.');
        events.push({sequence:++sequence,time:performance.now(),type,detail});
    };
    const wait=async(name:string,detail:unknown)=>{
        const gate=gates.get(name); if(!gate)return;
        if(gate.entered)throw Error('Rollout gate entered twice: '+name);
        gate.entered=true;record('gate-entered',{name,detail});
        if(gate.mode==='reject')throw gate.error;
        await new Promise<void>(resolve=>{gate.resolve=resolve;});
    };
    return {
        arm(name:string,mode:'hold'|'reject'='hold'){
            if(!['prepare','release'].includes(name)||!['hold','reject'].includes(mode)||gates.has(name))throw Error('Invalid/repeated rollout gate.');
            if(name==='prepare'&&mode==='reject')throw Error('Prepare rejection is not a rollout gate.');
            gates.set(name,{mode,entered:false,released:false,error:Error('Synthetic rollout pin-release rejection.')});
        },
        release(name:string){
            const gate=gates.get(name);
            if(!gate?.entered||gate.released||gate.mode!=='hold'||!gate.resolve)throw Error('No entered rollout hold.');
            gate.released=true;record('gate-released',name);gate.resolve();
        },
        request(type:unknown,id:unknown){record('request',{type,id});},
        async beforeReply(type:unknown,value:unknown){
            if(type==='capture-export-prepare')await wait('prepare',value);
            record('reply',{type,value});
        },
        pin(pin:{through:number;release():Promise<void>}){
            if(pins.length>=2)throw Error('Rollout pin bound exceeded.');
            const index=pins.length;
            const state={through:pin.through,calls:0,delegated:0,released:false};pins.push(state);
            return {through:pin.through,release:async()=>{
                state.calls++;record('pin-release-called',index);
                if(state.calls!==1)throw Error('Rollout observed repeated pin release.');
                await wait('release',state.through);
                state.delegated++;await pin.release();state.released=true;record('pin-release-acknowledged',state.through);
            }};
        },
        snapshot(){return {generation:__ROLLOUT_GENERATION__,events:structuredClone(events),pins:structuredClone(pins),gates:[...gates].map(([name,g])=>({name,mode:g.mode,entered:g.entered,released:g.released}))};}
    };
})();`;
const inspector = String.raw`
const __memoryChecked=(value:any,keys:string[])=>{for(const key of keys)if(!Object.hasOwn(value,key))throw Error('Worker ownership field absent: '+key);return value;};
(globalThis as any).__memoryProductWorker={
    faults:__memoryWorkerReadFault,
    quotaMessage:__memoryWorkerQuotaMessage,
    ledger:()=>__memoryWorkerLedger.snapshot(),
    async closeIdleStores(){
        const before=await this.snapshot();
        if(Object.values(before.owners).some((value:any)=>value!==0)||before.jobs.length)throw Error('Cannot retire a worker with live actual operations.');
        if(capturePromise)await(await capturePromise).close();
        if(consolePromise)await(await consolePromise).close();
        const after=__memoryWorkerLedger.snapshot();
        if(after.connections.length||Object.values(after.owners).some(value=>value!==0))throw Error('Independent worker IDB close remains unjoined.');
        return {before,after,scope:'Actual idle-store closes; broker caches survive until separately observed worker-target destruction.'};
    },
    async snapshot(){
        const b=brokerPromise?__memoryChecked(await brokerPromise,['jobs','finished','preparing']):null;
        const c=capturePromise?__memoryChecked(await capturePromise,['leases','reserving','active','opening','initializing','operation','recording','closed']):null;
        const j=consolePromise?__memoryChecked(await consolePromise,['readers','transactions','writer','captureWriter','activity','operation','closing','ended']):null;
        const jobs=b?[...b.jobs.values()].map((job:any)=>({id:job.id,state:job.state,bytes:job.bytes,iterator:Boolean(job.iterator),ending:Boolean(job.ending),watchdog:Boolean(job.watchdog),retirement:job.retirement??null,cleanupFailed:job.cleanupFailed===true})):[];
        return {owners:{export:b?b.jobs.size+b.preparing:0,pin:c?c.leases.size+c.reserving:0,reader:__memoryWorkerReadFault.activeReads()+(j?j.readers:0),writer:c?Number(Boolean(c.active))+Number(Boolean(c.initializing))+Number(Boolean(c.operation))+Number(Boolean(c.recording)):0,cleanup:(j?j.transactions.size+Number(Boolean(j.operation))+Number(Boolean(j.closing)&&!j.ended):0)+jobs.filter((job:any)=>job.ending).length},jobs,services:{captureConnection:c?!c.closed:false,consoleConnection:j?!j.ended:false},cache:{finished:b?b.finished.size:0},fault:__memoryWorkerReadFault.status()};
    }
};`;

/** Builds the same shipping worker with read-only probes and an explicit synthetic fault gate. */
export async function productExportWorker(sourceRoot: string, rollout?: ExportRolloutBuild) {
    const entry = path.join(
        sourceRoot,
        'src/features/automation/capture/capture-download-worker.ts',
    );
    return (
        await build({
            entryPoints: [entry],
            bundle: true,
            format: 'iife',
            platform: 'browser',
            target: 'es2022',
            write: false,
            plugins: [
                {
                    name: 'private-product-export-observer',
                    setup(builder) {
                        builder.onLoad(
                            {
                                filter: /[\\/](export-broker|indexeddb-store|indexeddb-console)\.ts$/,
                            },
                            async ({ path: file }) => {
                                const preimages: Record<string, string> = {
                                    'export-broker.ts':
                                        rollout?.generation === 'pre-fix-candidate' ? legacyBrokerSHA : brokerSHA,
                                    'indexeddb-store.ts':
                                        'c7e5c7c9b6caa52552b1e566bfdc67d9db5057d4d2385eba18a1ff819bd34fee',
                                    'indexeddb-console.ts':
                                        '9d80bd2305f7427331a95c4783ce7f5c18a5c2e96e6b44f67e99b9f214e46450',
                                };
                                const source = await checkedRead(file, rollout);
                                if (
                                    createHash('sha256').update(source).digest('hex') !==
                                    preimages[path.basename(file)]
                                )
                                    throw Error(
                                        'Export ownership source preimage changed: ' +
                                            path.basename(file),
                                    );
                                return { contents: source, loader: 'ts' };
                            },
                        );
                        builder.onLoad(
                            { filter: /[\\/]capture-download-worker\.ts$/ },
                            async ({ path: file }) => {
                                let source = await checkedRead(file, rollout);
                                if (createHash('sha256').update(source).digest('hex') !== workerSHA)
                                    throw Error('Actual export worker preimage changed.');
                                const needle = 'IndexedDbCaptureStore.open().catch((error) => {';
                                if (source.split(needle).length !== 2)
                                    throw Error('Worker capture repository boundary changed.');
                                source = source.replace(
                                    needle,
                                    'IndexedDbCaptureStore.open().then(__memoryWorkerReadFault.wrap).catch((error) => {',
                                );
                                let controls = '';
                                if (rollout) {
                                    const replacements = [
                                        ['pin: async () => (await captures()).pin(),', 'pin: async () => __memoryRollout.pin(await (await captures()).pin()),'],
                                        ['let value: unknown;', 'let value: unknown;\n                __memoryRollout.request(data.type, data.id);'],
                                        ['port.postMessage({ ok: true, value });', 'await __memoryRollout.beforeReply(data.type, value);\n                port.postMessage({ ok: true, value });'],
                                    ];
                                    for (const [before, after] of replacements) {
                                        if (source.split(before).length !== 2) throw Error('Rollout worker boundary changed.');
                                        source = source.replace(before, after);
                                    }
                                    controls = rolloutWorkerControl.replace('__ROLLOUT_GENERATION__', JSON.stringify(rollout.generation));
                                }
                                const fault = path
                                    .join(
                                        sourceRoot,
                                        'tests/fixtures/memory-product-worker-faults.ts',
                                    )
                                    .replaceAll('\\', '/');
                                const ledger = path
                                    .join(
                                        sourceRoot,
                                        'tests/fixtures/memory-product-worker-ledger.ts',
                                    )
                                    .replaceAll('\\', '/');
                                return {
                                    contents:
                                        'import {workerReadFault as __memoryWorkerReadFault,workerQuotaMessage as __memoryWorkerQuotaMessage} from ' +
                                        JSON.stringify(fault) +
                                        ';\nimport {installProductWorkerLedger} from ' +
                                        JSON.stringify(ledger) +
                                        ';\nconst __memoryWorkerLedger=installProductWorkerLedger();\n' +
                                        controls + '\n' + source +
                                        '\n' +
                                        inspector + (rollout ? '\n(globalThis as any).__exportRolloutWorker=__memoryRollout;' : ''),
                                    loader: 'ts',
                                };
                            },
                        );
                        if (rollout) builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path: file }) => ({
                            contents: await checkedRead(file, rollout),
                            loader: file.endsWith('tsx') ? 'tsx' : file.endsWith('ts') ? 'ts' : 'js',
                        }));
                    },
                },
            ],
        })
    ).outputFiles[0].contents;
}

/** Private page bootstrap; all product modules come from the explicitly pinned root. */
export async function productExportRolloutPage(sourceRoot: string, fixtureEntry: string, rollout: ExportRolloutBuild) {
    const product = (name: string) => JSON.stringify(path.join(sourceRoot, name));
    return (await build({
        stdin: { contents: `import {installRolloutPage} from ${JSON.stringify(fixtureEntry)};
import {startBrowserCaptureExport} from ${product('src/features/automation/capture/browser-export.ts')};
import {IndexedDbCaptureStore} from ${product('src/features/automation/capture/indexeddb-store.ts')};
import {CaptureWriter} from ${product('shared/capture-writer.ts')};
installRolloutPage({start:startBrowserCaptureExport,Store:IndexedDbCaptureStore,Writer:CaptureWriter},${JSON.stringify(rollout.generation)});`, resolveDir: sourceRoot, sourcefile: 'rollout-private-entry.ts' },
        bundle: true, platform: 'browser', format: 'iife', target: 'es2022', write: false,
        plugins: [{name: 'private-pinned-rollout-page', setup(builder) {
            builder.onLoad({filter: /\.[cm]?[jt]sx?$/}, async ({path: file}) => {
                let source = await checkedRead(file, rollout);
                if (path.basename(file) === 'browser-export.ts') {
                    const expected = rollout.generation === 'pre-fix-candidate'
                        ? 'b5809fbfc213feea85eb989796333bec93395b4ed394e83112c7312f862dbf7a'
                        : '79de398abcccca1b18d274ff5302b01b7eb7220e8c64a87d30ef2de4083b9996';
                    if (createHash('sha256').update(source).digest('hex') !== expected)
                        throw Error('Rollout helper preimage changed.');
                    source += '\nObject.defineProperty(globalThis,"__rolloutHelperProbe",{value:()=>({activeExports,slots:helpers.length,busy:helpers.filter(h=>h.busy).length})});';
                }
                return {contents: source, loader: file.endsWith('tsx') ? 'tsx' : file.endsWith('ts') ? 'ts' : 'js'};
            });
        }}],
    })).outputFiles[0].contents;
}
