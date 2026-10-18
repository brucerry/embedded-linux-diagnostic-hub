import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const workerSHA = 'cf0b105ac581dbedc881fa3579467738aecca3772b622b4d02ee9251410c2424';
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
        const jobs=b?[...b.jobs.values()].map((job:any)=>({id:job.id,state:job.state,bytes:job.bytes,iterator:Boolean(job.iterator),ending:Boolean(job.ending),watchdog:Boolean(job.watchdog)})):[];
        return {owners:{export:b?b.jobs.size+b.preparing:0,pin:c?c.leases.size+c.reserving:0,reader:__memoryWorkerReadFault.activeReads()+(j?j.readers:0),writer:c?Number(Boolean(c.active))+Number(Boolean(c.initializing))+Number(Boolean(c.operation))+Number(Boolean(c.recording)):0,cleanup:(j?j.transactions.size+Number(Boolean(j.operation))+Number(Boolean(j.closing)&&!j.ended):0)+jobs.filter((job:any)=>job.ending).length},jobs,services:{captureConnection:c?!c.closed:false,consoleConnection:j?!j.ended:false},cache:{finished:b?b.finished.size:0},fault:__memoryWorkerReadFault.status()};
    }
};`;

/** Builds the same shipping worker with read-only probes and an explicit synthetic fault gate. */
export async function productExportWorker(sourceRoot: string) {
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
                                        'a98d97f967f714c479087a1f1db811430e7e090d2e4a3d8116a7fb3ef2236066',
                                    'indexeddb-store.ts':
                                        'c7e5c7c9b6caa52552b1e566bfdc67d9db5057d4d2385eba18a1ff819bd34fee',
                                    'indexeddb-console.ts':
                                        '9d80bd2305f7427331a95c4783ce7f5c18a5c2e96e6b44f67e99b9f214e46450',
                                };
                                const source = await fs.readFile(file, 'utf8');
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
                                let source = await fs.readFile(file, 'utf8');
                                if (createHash('sha256').update(source).digest('hex') !== workerSHA)
                                    throw Error('Actual export worker preimage changed.');
                                const needle = 'IndexedDbCaptureStore.open().catch((error) => {';
                                if (source.split(needle).length !== 2)
                                    throw Error('Worker capture repository boundary changed.');
                                source = source.replace(
                                    needle,
                                    'IndexedDbCaptureStore.open().then(__memoryWorkerReadFault.wrap).catch((error) => {',
                                );
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
                                        source +
                                        '\n' +
                                        inspector,
                                    loader: 'ts',
                                };
                            },
                        );
                    },
                },
            ],
        })
    ).outputFiles[0].contents;
}
