'use strict';
// Nonshipping synchronous loader control. Import is inert; native ports are supplied explicitly.
const assert = require('node:assert/strict');
const path = require('node:path');
const { types } = require('node:util');
const { fileURLToPath, pathToFileURL } = require('node:url');
const retained = new Set();
const policy = 'required-root-and-explicit-cpu-absence-v1';
function createInstrumentedResolutionGuard(root, ports) {
    assert.ok(typeof root === 'string' && root.startsWith('/') && path.posix.normalize(root) === root && Buffer.byteLength(root) <= 4096 && !/[\\\x00-\x20\x7f]/.test(root));
    assert.ok(root.endsWith('/validation/gateway-ownership/instrumented'));
    for (const k of ['registerHooks','isBuiltin','onViolation','onUncertain']) assert.equal(typeof ports[k], 'function');
    ports = Object.freeze({...ports});
    const creatorURL = pathToFileURL(root + '/node_modules/ssh2/lib/protocol/constants.js').href;
    let handle, owner, registered = false, closePrepared = false, failed = false, uncertain = false, rootBound = false, violationCode = null, resolutions = 0, optionalCpuBlocked = 0, outsideRejected = 0, nativeRejected = 0, missing = 0, notified = false;
    const inFlight = new Set(), unknown = new Set();
    function notify() { try { const value=ports.onViolation();if (value !== undefined) {watch(value);uncertain = true;} } catch { uncertain = true; } }
    function hold() {
        uncertain = true; retained.add(owner);
        if (!notified) { notified = true; try { const value=ports.onUncertain();if(value!==undefined){watch(value);failed=true;} } catch { failed = true; } }
    }
    function fail(code, unknownOutcome = false) { failed = true; violationCode ??= code; notify(); if (unknownOutcome || uncertain) hold(); }
    function watch(value) { unknown.add(value); try { if (types.isPromise(value)) Promise.prototype.then.call(value, undefined, () => {}); } catch {} }
    function error(code) { const e = Error('Private module containment rejected an unsupported operation.'); e.code = code; return e; }
    const snapshot = () => ({schema:'private-required-module-guard-v1',policy,registered,closePrepared,failed,uncertain,rootBound,
        inFlight:inFlight.size,resolutions,optionalCpuBlocked,outsideRejected,nativeRejected,missing,violationCode,wholeGroupRetirement:null,releaseAcceptance:false});
    function bind(expected) { assert.equal(expected, root); rootBound = true; }
    function resolve(specifier, context, nextResolve) {
        if (uncertain) { fail('resolution-unknown', true); throw error('HUB_GUARD_REJECTED'); }
        if (!registered) { fail('late-or-unregistered', true); throw error('HUB_GUARD_REJECTED'); }
        if (resolutions >= 4096 || inFlight.size >= 16) { fail('resolution-bound'); throw error('HUB_GUARD_REJECTED'); }
        resolutions++; const lease = {}; inFlight.add(lease); let acknowledged = true, expectedMissing = false;
        try {
            if (typeof specifier !== 'string' || specifier.length > 8192 || typeof nextResolve !== 'function') { fail('resolution-shape'); throw error('HUB_GUARD_REJECTED'); }
            let requestedBuiltin;try { requestedBuiltin = ports.isBuiltin(specifier); } catch { acknowledged = false; fail('builtin-unknown',true); throw error('HUB_GUARD_REJECTED'); }
            if (typeof requestedBuiltin !== 'boolean') { acknowledged = false; watch(requestedBuiltin); fail('builtin-unknown', true); throw error('HUB_GUARD_REJECTED'); }
            if (closePrepared && !requestedBuiltin) { fail('load-after-close-prepared'); throw error('HUB_GUARD_REJECTED'); }
            if (!context || typeof context!=='object' || types.isProxy(context)) {fail('resolution-shape');throw error('HUB_GUARD_REJECTED');}
            const parent=Object.getOwnPropertyDescriptor(context,'parentURL');
            if(parent&&!Object.hasOwn(parent,'value')){fail('resolution-shape');throw error('HUB_GUARD_REJECTED');}
            if (specifier === 'cpu-features') {
                if (parent?.value !== creatorURL || optionalCpuBlocked >= 1) { fail('cpu-caller-or-repeat'); throw error('HUB_GUARD_REJECTED'); }
                optionalCpuBlocked++; expectedMissing=true;throw error('MODULE_NOT_FOUND'); // Intentional omission, before any ancestor lookup.
            }
            let result;
            try { result = nextResolve(specifier, context); }
            catch (e) {
                const code=e&&typeof e==='object'&&!types.isProxy(e)?Object.getOwnPropertyDescriptor(e,'code')?.value:null;
                if (!requestedBuiltin && (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND')) { missing++;expectedMissing=true;throw e; }
                fail('resolution-error'); throw e;
            }
            if (types.isPromise(result)) { acknowledged = false; watch(result); fail('resolution-unknown',true); throw error('HUB_GUARD_REJECTED'); }
            if (types.isProxy(result)) { acknowledged=false;watch(result);fail('resolution-unknown',true);throw error('HUB_GUARD_REJECTED'); }
            if (!result || typeof result !== 'object' || (Object.getPrototypeOf(result) !== null && Object.getPrototypeOf(result) !== Object.prototype)) { fail('resolution-result'); throw error('HUB_GUARD_REJECTED'); }
            const descriptors = Object.getOwnPropertyDescriptors(result);
            if ('then' in result) { acknowledged = false; watch(result); fail('resolution-unknown', true); throw error('HUB_GUARD_REJECTED'); }
            const allowed = ['url','format','importAttributes','shortCircuit'];
            if (Reflect.ownKeys(descriptors).some(k => typeof k!=='string' || !allowed.includes(k) || !Object.hasOwn(descriptors[k], 'value')) || typeof result.url !== 'string' || result.url.length > 8192) { fail('resolution-result'); throw error('HUB_GUARD_REJECTED'); }
            if (result.format !== undefined && !['builtin','commonjs','module','json','addon'].includes(result.format)) { fail('resolution-format'); throw error('HUB_GUARD_REJECTED'); }
            if (result.shortCircuit !== undefined && typeof result.shortCircuit !== 'boolean') { fail('resolution-result'); throw error('HUB_GUARD_REJECTED'); }
            if (result.importAttributes !== undefined) {
                const attrs = result.importAttributes;
                if (!attrs || typeof attrs !== 'object' || types.isProxy(attrs) || ![null,Object.prototype].includes(Object.getPrototypeOf(attrs))) { fail('resolution-result'); throw error('HUB_GUARD_REJECTED'); }
                const rows = Object.getOwnPropertyDescriptors(attrs);
                if (Object.keys(rows).length > 16 || Object.entries(rows).some(([k,v]) => k.length > 256 || !Object.hasOwn(v,'value') || typeof v.value !== 'string' || v.value.length > 256)) { fail('resolution-result'); throw error('HUB_GUARD_REJECTED'); }
            }
            let builtin;try { builtin = ports.isBuiltin(result.url); } catch { acknowledged = false; fail('builtin-unknown',true); throw error('HUB_GUARD_REJECTED'); }
            if (typeof builtin !== 'boolean') { acknowledged=false;watch(builtin);fail('builtin-unknown', true); throw error('HUB_GUARD_REJECTED'); }
            if (builtin && result.url.startsWith('node:')) {
                const canonical=specifier.startsWith('node:')?specifier:'node:'+specifier;
                if ((requestedBuiltin&&result.url!==canonical)||(result.format!==undefined&&result.format!=='builtin')) {fail('builtin-mismatch');throw error('HUB_GUARD_REJECTED');}
                return result;
            }
            if (builtin || requestedBuiltin || closePrepared || result.format==='builtin') {fail('builtin-mismatch');throw error('HUB_GUARD_REJECTED');}
            let filename;
            try { const u = new URL(result.url); filename = fileURLToPath(u); assert.equal(u.host,''); assert.ok(!u.search && !u.hash); assert.equal(pathToFileURL(filename).href,result.url); assert.equal(path.posix.normalize(filename),filename); assert.ok(!/[\\\x00-\x1f\x7f]/.test(filename)); }
            catch { fail('unsupported-url'); throw error('HUB_GUARD_REJECTED'); }
            if (result.format==='addon' || filename.endsWith('.node')) { nativeRejected++; fail('native-module'); throw error('HUB_GUARD_REJECTED'); }
            if (!filename.startsWith(root+'/')) { outsideRejected++; fail('outside-root'); throw error('HUB_GUARD_REJECTED'); }
            return result;
        } catch(e) {if(!expectedMissing&&!failed)fail('resolution-error');throw e;} finally { if (acknowledged && !uncertain) inFlight.delete(lease); }
    }
    owner = Object.freeze({
        snapshot,
        assertActive(expected) { bind(expected); assert.ok(registered && !closePrepared && !failed && !uncertain && !inFlight.size); },
        assertClosePrepared(expected, allowFailure = false) { bind(expected); assert.ok(registered && closePrepared && !uncertain && !inFlight.size && (allowFailure || !failed)); },
        retainFailure() { fail('activation-unproved', true); },
        prepareClose(expected, allowFailure = false) {
            bind(expected); assert.equal(typeof allowFailure, 'boolean'); assert.equal(closePrepared, false);
            assert.ok(registered && handle && !inFlight.size && !uncertain && (allowFailure || !failed));
            closePrepared = true; return snapshot(); // Hook intentionally remains registered until direct Node exit.
        },
    });
    retained.add(owner);
    try {
        handle = ports.registerHooks({resolve});
        const validHandle=handle&&typeof handle==='object'&&!types.isProxy(handle)&&!types.isPromise(handle);
        const prototype=validHandle?Object.getPrototypeOf(handle):null;
        const descriptor=validHandle&&!types.isProxy(prototype)?(Object.getOwnPropertyDescriptor(handle,'deregister')??Object.getOwnPropertyDescriptor(prototype??{},'deregister')):null;
        if (!descriptor || !Object.hasOwn(descriptor,'value') || typeof descriptor.value!=='function' || 'then' in handle) { watch(handle); fail('registration-unknown', true); throw error('HUB_GUARD_REJECTED'); }
        registered = true;
        if (failed || uncertain) throw error('HUB_GUARD_REJECTED');
    } catch (e) { fail('registration-error', true); throw Object.assign(error('HUB_GUARD_REJECTED'), {owner}); }
    return owner;
}
module.exports = {createInstrumentedResolutionGuard};
