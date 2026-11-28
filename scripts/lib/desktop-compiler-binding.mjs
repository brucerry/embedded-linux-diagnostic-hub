import assert from 'node:assert/strict';
export const targets = Object.freeze({
    'linux/x64/gnu':'linux-x64-gnu',
    'win32/x64':'win32-x64-msvc',
    'darwin/x64':'darwin-x64',
    'darwin/arm64':'darwin-arm64',
});
export function selectReviewedBinding({ platform,arch,glibcVersion,env }, lock, wrapper) {
    assert.ok(!env.ROLLDOWN_NATIVE_BINDING_PATH && !env.NODE_PATH && !env.NODE_OPTIONS,
        'Compiler selection refuses loader or binding injection.');
    const key = platform+'/'+arch+(platform==='linux' && /^\d+\.\d+(?:\.\d+)?$/.test(glibcVersion??'')?'/gnu':'');
    assert.ok(Object.hasOwn(targets,key),'Unreviewed host architecture or libc.');
    const triple=targets[key];
    const name='@rolldown/binding-'+triple;
    const row=lock.packages['node_modules/'+name];
    assert.equal(wrapper.name,'rolldown');
    assert.equal(wrapper.version,lock.packages['node_modules/rolldown'].version);
    assert.equal(wrapper.version,'1.2.12');
    assert.equal(wrapper.optionalDependencies[name],wrapper.version);
    assert.equal(row.version,wrapper.version);
    assert.deepEqual(row.os,[platform]);
    assert.deepEqual(row.cpu,[arch]);
    assert.match(row.integrity,/^sha512-[A-Za-z0-9+/]+={0,2}$/);
    return {name, filename:'rolldown-binding.'+triple+'.node',version:row.version,integrity:row.integrity};
}
