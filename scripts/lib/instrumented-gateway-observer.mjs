import assert from 'node:assert/strict';
import {deriveWasmDiagnosticPlan,beginWasmDiagnostic,observeRejectedWasm,classifyRejectedWasm} from './instrumented-gateway-wasm-diagnostic.mjs';
import { deriveCpuOriginPlan, captureRejectionOrigin, observeOriginSource, classifyRejectionOrigin } from './instrumented-gateway-origin.mjs';
import { createRejectionFingerprint, fingerprintRejectedSource } from './instrumented-gateway-rejection.mjs';
import { deriveInstrumentedGeneratedInventory, SSH2_BIGINT_GENERATED_SOURCE } from './instrumented-gateway-generated.mjs';
import { INSPECTOR_FAILURE_CODES } from './instrumented-gateway-failure.mjs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const sourceObservers = new WeakMap();
const hash = (b) => createHash('sha256').update(b).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((a, b) => {
        resolve = a;
        reject = b;
    });
    promise.catch(() => {});
    return { promise, resolve, reject };
};
// Unsupported thenables are observed for rejection but never treated as retired.
function retainUnknown(value, held, fail) {
    held.add(value);
    try {
        const then = value?.then;
        if (typeof then === 'function') {
            const watched = then.call(value, () => {}, fail);
            if (watched instanceof Promise) Promise.prototype.then.call(watched, undefined, fail);
        }
    } catch (error) {
        fail(error);
    }
}
function binding(value) {
    assert.deepEqual(Object.keys(value).sort(), [
        'artifactPath',
        'artifactSHA256',
        'observerSHA256',
        'sourceCommit',
        'sourceTree',
    ]);
    for (const p of ['sourceCommit', 'sourceTree']) assert.match(value[p], /^[a-f0-9]{40}$/);
    for (const p of ['artifactSHA256', 'observerSHA256']) assert.match(value[p], /^[a-f0-9]{64}$/);
    assert.ok(
        typeof value.artifactPath === 'string' &&
            value.artifactPath.startsWith('/') &&
            value.artifactPath.length <= 4096 &&
            path.posix.normalize(value.artifactPath) === value.artifactPath &&
            !/[\\\x00-\x1f\x7f]/.test(value.artifactPath),
    );
    return Object.freeze({ ...value });
}
export class InstrumentedGatewayFailure extends Error {
    constructor(cause, owner) {
        super('Instrumented Gateway observation failed; inspect retained custody.', { cause });
        this.owner = owner;
    }
}
/** Actual inspector callback collector, with no native/session/process defaults or TCP API.
 * Selection is an independently admitted input, not build/service provenance supplied by this module.
 */
export function createCompiledSourceObserver(input, scripts, sessionFactory) {
    const selected = binding(input),
        expected = new Map();
    assert.ok(scripts instanceof Map && scripts.size > 0 && scripts.size <= 512);
    let expectedBytes = 0;
    for (const [filename, content] of scripts) {
        assert.ok(
            typeof filename === 'string' &&
                filename.startsWith('/') &&
                filename.length <= 4096 &&
                path.posix.normalize(filename) === filename &&
                !/[\\\x00-\x1f\x7f]/.test(filename),
        );
        const url = pathToFileURL(filename).href;
        assert.equal(
            new URL(url).pathname.split('/').some((p) => p === '.' || p === '..'),
            false,
        );
        assert.ok(Buffer.isBuffer(content) && content.length <= 32 * 1024 ** 2);
        expectedBytes += content.length;
        assert.ok(expectedBytes <= 64 * 1024 ** 2);
        const bytes = Buffer.from(content),
            text = decoder.decode(bytes);
        assert.ok(Buffer.from(text).equals(bytes));
        expected.set(url, { path: filename, bytes: bytes.length, text, sha256: hash(bytes) });
    }
    assert.equal(
        expected.get(pathToFileURL(selected.artifactPath).href)?.sha256,
        selected.artifactSHA256,
    );
    const generatedInventory=deriveInstrumentedGeneratedInventory(scripts,path.posix.dirname(selected.artifactPath));
    assert.equal(typeof sessionFactory, 'function');
    let session,
        acquisition = false,
        connected = false,
        registration = false,
        started,
        enabling,
        enableAcknowledged = false,
        earlyReady = false,
        earlyRequested = false,
        adopted = false,
        finishing,
        sealed = false,
        retired = false,
        primary,
        failureCode = null,
        events = 0,
        builtinScripts = 0,
        unknownOperations = 0;
    const originPlan=deriveCpuOriginPlan(scripts,selected.artifactPath),wasmPlan=deriveWasmDiagnosticPlan(scripts,selected.artifactPath);
    let wasmLease=null;
    const verifiedCreators=new Map(),sourceTasks=new Set(),tentativeGenerated=[],observedGenerated=[];
    let generatedDiagnostic=null,rejectionFingerprint=null,rejectionOrigin=null;
    const pending = new Set(),
        waiters = [],
        ids = new Set(),
        observed = [],
        retirement = deferred(),
        diagnostics = [],
        unknownReturns = new Set();
    const fail = (error,code='inspector-operation',diagnostic=null) => {
        if (primary && error !== primary && !diagnostics.includes(error) && diagnostics.length < 16)
            diagnostics.push(error);
        if(!primary){failureCode=INSPECTOR_FAILURE_CODES.includes(code)?code:'inspector-operation';generatedDiagnostic=diagnostic;}
        primary ??= error;
    };
    const sync = (actual, expected, operation) => {
        if (actual !== expected) {
            unknownOperations++;
            retainUnknown(actual, unknownReturns, fail);
            throw Error('Unsupported inspector ' + operation + ' lifetime.');
        }
    };
    const snapshot = () =>
        Object.freeze({
            enableAcknowledged, earlyReady,
            acquisitionHeld: acquisition,
            connected,
            listenerHeld: registration,
            pendingCallbacks: pending.size,
            pendingSourceClassifications:sourceTasks.size,wasmDiagnostic:wasmLease?{...wasmLease.record}:null,rejectionOrigin:rejectionOrigin?{...rejectionOrigin}:null,rejectionFingerprint:rejectionFingerprint?{...rejectionFingerprint}:null,generatedDiagnostic:generatedDiagnostic?{...generatedDiagnostic}:null,
            compiledScripts: observed.length,
            primaryFailure: Boolean(primary),
            failureCode,
            observerRetired: retired,
            cleanupDiagnostics: diagnostics.length,
            unknownOperations,
            processGroupRetirement: null,
        });
    const drain = () =>
        pending.size ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve();
    function post(method, params, diagnostic=null) {
        if(pending.size>=16){const error=Error('Inspector pending-callback bound exceeded.');fail(error,'inspector-pending-bound',diagnostic);throw error;}
        const lease = {},
            result = deferred();
        pending.add(lease);
        const done = (error, value) => {
            if (!pending.has(lease)) {
                if (!retired) fail(Error('Duplicate inspector callback.'));
                return;
            }
            if(method==='Debugger.enable'&&!error)enableAcknowledged=true;
            pending.delete(lease);
            if (error) {
                fail(error,'inspector-callback',diagnostic);
                result.reject(error);
            } else result.resolve(value);
            if (!pending.size) for (const resolve of waiters.splice(0)) resolve();
        };
        try {
            sync(session.post(method, params, done), undefined, 'dispatch');
        } catch (error) {
            fail(error,'inspector-dispatch',diagnostic);
            result.reject(error);
            // Throw after dispatch is not acknowledgement. Keep the lease unless callback acknowledged it.
        }
        return result.promise;
    }
    function trackSource(promise,diagnostic=null){
        assert.ok(sourceTasks.size<2048);const task=promise.catch(error=>fail(error,'source-response',diagnostic));sourceTasks.add(task);
        void task.then(()=>sourceTasks.delete(task));
    }
    async function drainSources(){while(sourceTasks.size)await Promise.all([...sourceTasks]);}
    function unknownScript(p,liveAtNotification){
        const plan=generatedInventory[0],urlKind=p.url===''?'empty':p.url.startsWith('file:')?'file-url':p.url.startsWith('/')?'absolute-path':'other';
        const frames=p.stackTrace?.callFrames,frame=Array.isArray(frames)&&frames.length>0&&frames.length<=32?frames[0]:null;
        const stackPresent=!!frame,originURL=plan?pathToFileURL(plan.originPath).href:null;
        const siteMatched=!!(frame&&plan&&frame.url===originURL&&frame.lineNumber===plan.originLine&&frame.columnNumber===plan.originColumn&&typeof frame.scriptId==='string'&&frame.scriptId.length>0&&frame.scriptId.length<=64);
        const shapeMatched=!!(plan&&p.url===''&&p.length===plan.sourceUnits&&p.isModule!==true);
        const diagnostic={urlKind,declaredUnits:Number.isSafeInteger(p.length)&&p.length>=0&&p.length<=10000?p.length:null,creatorPinned:!!plan,shapeMatched,
            stackPresent,siteMatched,nonModuleVerified:p.isModule===false,sourceMatched:null,sourceSHA256:null,sourceBytes:null,creatorSourceVerified:null,contextMatched:null};
        if(!shapeMatched){
            const firstPrimary=!primary,fingerprint=firstPrimary?createRejectionFingerprint(p,expected,selected.artifactPath):null;
            // Latch rejection before diagnostic dispatch; callback errors cannot replace it.
            fail(Error('Unadmitted compiled script.'),'script-unadmitted',diagnostic);
            if(firstPrimary&&!wasmLease){wasmLease=beginWasmDiagnostic(p,wasmPlan);if(wasmLease.record.status==='pending'){try{trackSource(post('Debugger.getScriptSource',{scriptId:p.scriptId}).then(result=>observeRejectedWasm(wasmLease,result)).catch(()=>{wasmLease.record.status='rpc-rejected';}));}catch{wasmLease.record.status='rpc-rejected';}}}
            if(fingerprint){
                rejectionFingerprint=fingerprint;rejectionOrigin=captureRejectionOrigin(p,originPlan,expected,liveAtNotification);
                try{trackSource(post('Debugger.getScriptSource',{scriptId:p.scriptId}).then(result=>{
                    fingerprintRejectedSource(fingerprint,result?.scriptSource,expected,pathToFileURL(selected.artifactPath).href);
                    if(fingerprint.status==='fingerprinted')observeOriginSource(rejectionOrigin,result.scriptSource);
                }).catch(()=>{fingerprint.status='rpc-rejected';}));}
                catch{fingerprint.status='rpc-rejected';}
            }
            return;
        }
        if(tentativeGenerated.length){fail(Error('Generated cardinality exceeded.'),'generated-cardinality',diagnostic);return;}
        const candidate={plan,diagnostic,liveAtNotification,frameId:frame&&typeof frame.scriptId==='string'&&frame.scriptId.length>0&&frame.scriptId.length<=64?frame.scriptId:null,context:Number.isSafeInteger(p.executionContextId)&&p.executionContextId>0?p.executionContextId:null};
        tentativeGenerated.push(candidate);
        trackSource(post('Debugger.getScriptSource',{scriptId:p.scriptId},diagnostic).then(result=>{
            if(!result||typeof result.scriptSource!=='string'||result.scriptSource.length!==plan.sourceUnits){diagnostic.sourceMatched=false;fail(Error('Generated source response did not match the sealed candidate.'),'generated-source-mismatch',diagnostic);return;}
            const bytes=Buffer.from(result.scriptSource);diagnostic.sourceSHA256=hash(bytes);diagnostic.sourceBytes=bytes.length;
            diagnostic.sourceMatched=result.scriptSource===SSH2_BIGINT_GENERATED_SOURCE&&bytes.length===plan.sourceBytes&&diagnostic.sourceSHA256===plan.sourceSHA256;
            if(!diagnostic.sourceMatched)fail(Error('Generated bytes differ from the sealed candidate.'),'generated-source-mismatch',diagnostic);
        }),diagnostic);
    }
    function classifyGenerated(){
        for(const candidate of tentativeGenerated){
            if(candidate.classified)continue;candidate.classified=true;
            const {plan,diagnostic}=candidate,creator=candidate.frameId?verifiedCreators.get(candidate.frameId):null;
            diagnostic.creatorSourceVerified=!!(creator&&creator.path===plan.originPath&&creator.sha256===plan.originSHA256&&creator.zeroOffset);
            diagnostic.contextMatched=!!(creator&&candidate.context!==null&&creator.context!==null&&creator.context===candidate.context);
            if(candidate.liveAtNotification&&diagnostic.nonModuleVerified&&diagnostic.sourceMatched&&diagnostic.siteMatched&&diagnostic.creatorSourceVerified&&diagnostic.contextMatched){
                observedGenerated.push({identity:plan.identity,sourceSHA256:plan.sourceSHA256,sourceBytes:plan.sourceBytes,creatorSourceVerified:true,creationStackVerified:true});
            }else fail(Error('Generated creator identity remains unproved.'),'generated-origin-unproved',diagnostic);
            candidate.frameId=null;
        }
    }
    function parsed(message) {
        if (retired) return; // A stale callback cannot mutate a later session or completed receipt.
        let code='script-metadata';
        try {
            assert.ok(!sealed && ++events <= 2048, 'Late/overflow inspector observation.');
            const liveAtNotification=enableAcknowledged; // Capture before any source RPC/await; replay cannot become live later.
            const p = message?.params;
            if(p?.isLiveEdit){code='script-live-edit';assert.fail('Live edited scripts are unsupported.');}
            if(p?.hasSourceURL){code='script-source-url';assert.fail('SourceURL scripts are unsupported.');}
            assert.ok(
                p &&
                    typeof p.url === 'string' &&
                    p.url.length <= 8192 &&
                    !p.isLiveEdit &&
                    !p.hasSourceURL,
            );
            code='script-id';
            assert.ok(
                typeof p.scriptId === 'string' &&
                    p.scriptId.length > 0 &&
                    p.scriptId.length <= 64 &&
                    !ids.has(p.scriptId),
            );
            ids.add(p.scriptId);
            if (p.url.startsWith('node:')) {
                builtinScripts++;
                return;
            }
            code='script-unadmitted';
            const wanted = expected.get(p.url);
            if(!wanted){unknownScript(p,liveAtNotification);return;}
            code='script-length';
            if (p.length !== undefined) assert.equal(p.length, wanted.text.length);
            code='inspector-operation';
            trackSource(post('Debugger.getScriptSource', { scriptId: p.scriptId })
                .then((result) => {
                    if(!result||typeof result.scriptSource!=='string'){fail(Error('Missing inspector source response.'),'source-response');return;}
                    if(result.scriptSource!==wanted.text){fail(Error('Actual compiled source differs from admitted bytes.'),'source-content');return;}
                    assert.ok(
                        result.scriptSource === wanted.text,
                        'Actual compiled source differs from admitted bytes.',
                    );
                    verifiedCreators.set(p.scriptId,{liveAtNotification,path:wanted.path,sha256:wanted.sha256,zeroOffset:p.startLine===0&&p.startColumn===0,context:Number.isSafeInteger(p.executionContextId)&&p.executionContextId>0?p.executionContextId:null});
                    observed.push({
                        path: wanted.path,
                        bytes: wanted.bytes,
                        sha256: wanted.sha256,
                    });
                })
                .catch(error=>fail(error,'source-response')));
        } catch (error) {
            fail(error,code);
        }
    }
    function enableOwned() {
        assert.ok(!sealed&&!finishing&&!retired,'Observer admission is closed.');
        if(enabling)return enabling;
        enabling=(async()=>{
                acquisition = true;
                session = sessionFactory();
                if (
                    !session ||
                    !['connect', 'disconnect', 'post', 'on', 'off'].every(
                        (k) => typeof session[k] === 'function',
                    )
                ) {
                    unknownOperations++;
                    retainUnknown(session, unknownReturns, fail);
                    throw Error('Unsupported inspector factory result.');
                }
                registration = true;
                sync(session.on('Debugger.scriptParsed', parsed), session, 'registration');
                sync(session.connect(), undefined, 'connect');
                connected = true;
                await post('Debugger.enable', {});
                await drain();await drainSources();classifyGenerated();classifyRejectionOrigin(rejectionOrigin,verifiedCreators);classifyRejectedWasm(wasmLease,verifiedCreators);
                if(primary)throw primary;
        })().catch(error=>{fail(error,'observer-admission');throw new InstrumentedGatewayFailure(primary,owner);});
        enabling.catch(()=>{});return enabling;
    }
    const owner = Object.freeze({
        snapshot,
        failure: () => primary,
        rejectAdmission() {fail(Error('Preimport admission was stopped.'),'observer-admission');},
        diagnostics: () => Object.freeze([...diagnostics]),
        retirement: retirement.promise,
        async enableBeforeImport() {
            assert.ok(!started&&!earlyRequested);earlyRequested=true;
            try {await enableOwned();assert.ok(!primary&&!sealed&&!retired);assert.ok(!observed.some(row=>row.path===selected.artifactPath),'Target was already compiled before preimport admission.');earlyReady=true;}
            catch(error){fail(error,'observer-admission');throw error;}
        },
        start() {
            assert.ok(!sealed && !finishing && !retired, 'Observer admission is closed.');
            if (started) return started;
            started = (async () => {
                await enableOwned();
                await drain();await drainSources();classifyGenerated();classifyRejectionOrigin(rejectionOrigin,verifiedCreators);classifyRejectedWasm(wasmLease,verifiedCreators);
                if(!observed.some((r)=>r.path===selected.artifactPath)){
                    const error=Error('Instrumented entry was not observed compiled.');fail(error,'entry-missing');throw error;
                }
                if (primary) throw primary;
            })().catch((error) => {
                fail(error,'observer-admission');
                throw new InstrumentedGatewayFailure(primary, owner);
            });
            started.catch(() => {});
            return started;
        },
        finish() {
            if (finishing) return finishing;
            sealed = true;
            finishing = (async () => {
                if (enabling) await enabling.catch(() => {});
                if (started) await started.catch(() => {});
                await drain();await drainSources();classifyGenerated();classifyRejectionOrigin(rejectionOrigin,verifiedCreators);classifyRejectedWasm(wasmLease,verifiedCreators);
                assert.equal(unknownOperations, 0, 'Unknown inspector operation remains held.');
                // Disable is acknowledged before removing the owned listener or disconnecting.
                if (session && connected) await post('Debugger.disable', {});
                if (registration) {
                    sync(session.off('Debugger.scriptParsed', parsed), session, 'removal');
                    registration = false;
                }
                if (session) {
                    sync(session.disconnect(), undefined, 'disconnect');
                    connected = false;
                    acquisition = false;
                }
                assert.ok(!acquisition && !registration && !pending.size&&!sourceTasks.size);
                if (!observed.some((r) => r.path === selected.artifactPath))
                    fail(Error('Instrumented entry was not observed compiled.'),'entry-missing');
                expected.clear();verifiedCreators.clear();
                retired = true;
                retirement.resolve(snapshot());
                if (primary) throw primary;
                return {
                    selected: { ...selected },
                    compiledScripts: observed.map((r) => ({ ...r })),
                    generatedScripts:observedGenerated.map(r=>({...r})),
                    builtinScripts,
                    observation: 'inspector-returned-exact-script-source',
                    builtinIdentityVerified: false,
                    executedWorkloadCoverage: null,
                    kernelExecutableMapping: null,
                    observerRetired: true,
                };
            })().catch((error) => {
                fail(error,'observer-retirement');
                throw new InstrumentedGatewayFailure(primary, owner);
            });
            finishing.catch(() => {});
            return finishing;
        },
    });
    sourceObservers.set(owner,{adopt(expectedInput,expectedScripts){assert.ok(earlyReady&&!adopted&&!started&&!finishing&&!retired&&!primary);adopted=true;assert.deepEqual(binding(expectedInput),selected);assert.equal(expectedScripts.size,expected.size);for(const [filename,bytes]of expectedScripts){const v=expected.get(pathToFileURL(filename).href);assert.ok(v&&Buffer.isBuffer(bytes)&&hash(bytes)===v.sha256&&bytes.equals(Buffer.from(v.text)));}return owner;}});
    return owner;
}
export function adoptPreimportObserver(observer,input,scripts){const record=sourceObservers.get(observer);assert.ok(record,'Actual same-instance early observer required.');return record.adopt(input,scripts);}
const counters = [
    'cleanupTimers',
    'requestTasks',
    'httpSockets',
    'httpResponses',
    'httpBodyReaders',
    'pendingConnections',
    'sessions',
    'inFlight',
    'ownedSessions',
    'retiringSessions',
    'connectionAttempts',
    'cancelledAttemptCache',
];
function productSnapshot(gateway, closed = false) {
    const actual = gateway.ownershipSnapshot;
    assert.ok(
        actual &&
            typeof actual.stopping === 'boolean' &&
            typeof actual.serverListening === 'boolean',
    );
    /** @type {Record<string, boolean | number>} */
    const result = { stopping: actual.stopping, serverListening: actual.serverListening };
    for (const key of counters) {
        assert.ok(Number.isSafeInteger(actual[key]) && actual[key] >= 0);
        result[key] = actual[key];
    }
    for (const key of ['sessionOwners', 'allSessionOwners']) {
        assert.ok(Array.isArray(actual[key]));
        result[key] = actual[key].length;
    }
    if (closed) {
        assert.equal(result.stopping, true);
        assert.equal(result.serverListening, false);
        for (const key of [...counters, 'sessionOwners', 'allSessionOwners'])
            assert.equal(result[key], 0, 'Product cleanup remains owned: ' + key);
    }
    return result;
}
/** Non-shipping bootstrap for actual createGateway, with no server/process defaults.
 * It does not replace or qualify the shipped CLI, and never proves OS process retirement.
 */
export function createInstrumentedGatewayBootstrap(input,scripts,sessionFactory,createGateway){return bootstrapWithLoader(input,createCompiledSourceObserver(input,scripts,sessionFactory),createGateway);}
export function createInstrumentedGatewayBootstrapFromObserver(input,scripts,observer,createGateway){return bootstrapWithLoader(input,adoptPreimportObserver(observer,input,scripts),createGateway);}
function bootstrapWithLoader(input,loader,createGateway){
    const selected=binding(input);
    assert.equal(typeof createGateway, 'function');
    let startTask,
        closeTask,
        gateway,
        factoryHeld = false,
        admissionClosed = false,
        primary,
        phase = 'prepared',
        listenTask,
        listenerHeld = false,
        afterClose,
        unknownServerOperations = 0;
    const retirement = deferred(),
        diagnostics = [],
        unknownReturns = new Set();
    const fail = (error) => {
        if (primary && error !== primary && !diagnostics.includes(error) && diagnostics.length < 16)
            diagnostics.push(error);
        primary ??= error;
        phase = 'failed';
    };
    const sync = (actual, expected, operation) => {
        if (actual !== expected) {
            unknownServerOperations++;
            retainUnknown(actual, unknownReturns, fail);
            throw Error('Unsupported server ' + operation + ' lifetime.');
        }
    };
    const snapshot = () =>
        Object.freeze({
            phase,
            factoryHeld,
            productHeld: Boolean(gateway),
            serverListenerHeld: listenerHeld,
            loader: loader.snapshot(),
            primaryFailure: Boolean(primary),
            localRetirementAcknowledged: Boolean(afterClose),
            cleanupDiagnostics: diagnostics.length,
            unknownServerOperations,
            processGroupRetirement: null,
            releaseAcceptance: false,
        });
    let onError, onListening;
    function detach() {
        if (!listenerHeld) return;
        sync(gateway.server.off('error', onError), gateway.server, 'removal');
        sync(gateway.server.off('listening', onListening), gateway.server, 'removal');
        listenerHeld = false;
    }
    const owner = Object.freeze({
        snapshot,
        diagnostics: () => Object.freeze([...diagnostics]),
        retirement: retirement.promise,
        start(config) {
            assert.ok(!admissionClosed);
            if (startTask) return startTask;
            const configSnapshot = structuredClone(config);
            phase = 'starting';
            startTask = (async () => {
                await loader.start();
                assert.ok(!admissionClosed, 'Bootstrap closed before product acquisition.');
                factoryHeld = true;
                gateway = createGateway(configSnapshot);
                if (!gateway || typeof gateway.close !== 'function' || !gateway.server) {
                    retainUnknown(gateway, unknownReturns, fail);
                    throw Error('Unsupported product factory result.');
                }
                factoryHeld = false;
                productSnapshot(gateway);
                phase = 'active';
                return owner;
            })().catch((error) => {
                fail(error);
                throw new InstrumentedGatewayFailure(primary, owner);
            });
            startTask.catch(() => {});
            return startTask;
        },
        listen(port = 0) {
            assert.ok(gateway && phase === 'active' && !admissionClosed && !listenTask);
            assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535);
            const result = deferred();
            listenTask = result.promise;
            listenerHeld = true;
            onError = (error) => {
                if (afterClose) return;
                fail(error);
                result.reject(new InstrumentedGatewayFailure(primary, owner));
            };
            onListening = () => {
                if (afterClose) return;
                try {
                    const address = gateway.server.address();
                    assert.ok(
                        address &&
                            address.address === '127.0.0.1' &&
                            Number.isInteger(address.port) &&
                            address.port > 0 &&
                            address.port <= 65535,
                    );
                    result.resolve({ host: '127.0.0.1', port: address.port });
                } catch (error) {
                    onError(error);
                }
            };
            try {
                for (const [event, callback] of [
                    ['error', onError],
                    ['listening', onListening],
                ]) {
                    sync(gateway.server.on(event, callback), gateway.server, 'registration');
                }
                sync(gateway.server.listen(port, '127.0.0.1'), gateway.server, 'bind');
            } catch (error) {
                onError(error);
            }
            return listenTask;
        },
        sample() {
            assert.ok(gateway && !admissionClosed);
            try {
                return productSnapshot(gateway);
            } catch (error) {
                fail(error);
                throw new InstrumentedGatewayFailure(primary, owner);
            }
        },
        close() {
            if (closeTask) return closeTask;
            admissionClosed = true;
            closeTask = (async () => {
                if (startTask) await startTask.catch(() => {});
                if (listenTask) await listenTask.catch(() => {});
                assert.equal(unknownServerOperations, 0, 'Unknown server operation remains held.');
                assert.ok(!factoryHeld, 'Unknown product factory acquisition remains held.');
                let product;
                if (gateway) {
                    await gateway.close();
                    product = productSnapshot(gateway, true);
                    detach();
                    gateway = undefined;
                }
                let compiled;
                try {
                    compiled = await loader.finish();
                } catch (error) {
                    fail(error);
                    if (!loader.snapshot().observerRetired) throw error;
                }
                afterClose = { product, observerRetired: loader.snapshot().observerRetired };
                if (!primary && !loader.failure()) phase = 'local-owners-closed';
                retirement.resolve(snapshot());
                if (primary || loader.failure()) throw primary ?? loader.failure();
                const record = {
                    schemaVersion: 1,
                    kind: 'instrumented-gateway-ownership-observation',
                    instrumented: true,
                    sourceSelection: { ...selected },
                    compiled,
                    buildProvenanceVerified: false,
                    productCloseAcknowledged: Boolean(product),
                    productCountersAfterClose: product ?? null,
                    localObserverRetirementAcknowledged: true,
                    processGroupRetirement: null,
                    shippedCLIBehavior: null,
                    shippingPerformance: null,
                    shippingGC: null,
                    releaseAcceptance: false,
                };
                const bytes = Buffer.from(JSON.stringify(record) + '\n');
                assert.ok(bytes.length <= 4 * 1024 ** 2);
                return Object.freeze({ record, bytes, sha256: hash(bytes) });
            })().catch((error) => {
                fail(error);
                throw new InstrumentedGatewayFailure(primary, owner);
            });
            closeTask.catch(() => {});
            return closeTask;
        },
    });
    return owner;
}
