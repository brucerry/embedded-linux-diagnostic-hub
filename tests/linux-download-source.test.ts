import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Read-only source contracts are separate from the shell/temporary-file fixtures.
const source = readFileSync('public/download-run.sh', 'utf8');
const mac = readFileSync('public/download-run-macos.sh', 'utf8');
function section(text: string, begin: string, end: string) {
    const first = text.indexOf(begin);
    const last = text.indexOf(end, first);
    assert.ok(first >= 0 && last > first);
    return text.slice(first, last);
}

test('Linux and Mac preserve the same reviewed path guards and portable consent boundary', () => {
    const macGuards = section(mac, '# BEGIN GUARDED PATHS', '# END GUARDED PATHS');
    const linuxGuards = section(source, '# BEGIN GUARDED PATHS', '# END GUARDED PATHS');
    assert.equal(linuxGuards.replace("stat -c '%d:%i'", "stat -f '%d:%i'"), macGuards);
    assert.ok(
        source.indexOf('hub_make_directory_tree "$directory"') >
            source.indexOf('if hub_linux_confirm; then'),
    );
    assert.doesNotMatch(source, /--no-sandbox|sudo apt|chown|chmod \+s/);
});

test('Permanent download requires explicit separate intent and complete source records', () => {
    const selection = section(source, 'if [[ $permanent_choice == 1 ]]; then', '[[ $(uname -s)');
    assert.ok(selection.includes('[[ $portable_choice == 0 ]] || fail'));
    assert.ok(selection.includes('[[ $install_choice == 1 && -n $install_directory ]] || fail'));
    assert.ok(selection.includes('[[ $install_directory == /* && $install_directory != /'));
    assert.ok(selection.includes('format=tar.gz'));
    const handoff = section(
        source,
        'if [[ $permanent_choice == 1 ]]; then\n    [[ $source_available',
        '\ndirectory=${directory:-',
    );
    assert.ok(handoff.includes('[[ $source_available == 1 && $format == tar.gz ]] || fail'));
    assert.ok(handoff.includes('hub_validate_portable_tar || fail'));
    assert.ok(handoff.includes('--release-record "$staged/selected-release.json"'));
    assert.ok(handoff.includes('--build-record "$staged/linux-build-info.json"'));
    assert.ok(handoff.includes('--install-directory "$install_directory"'));
    const consent = handoff.indexOf('actual installer review/consent');
    const ancestry = handoff.indexOf('hub_assert_tree_bindings "$staged" || fail');
    const borrow = handoff.indexOf('trap - EXIT INT TERM');
    const launch = handoff.indexOf('exec "$flat/diagnostic-hub"');
    assert.ok(consent >= 0 && consent < ancestry && ancestry < borrow && borrow < launch);
    assert.ok(handoff.includes('"$flat/resources/linux-setup-bootstrap.cjs" "${args[@]}"'));
    assert.ok(
        source.includes('Permanent folder setup is a separate explicit --install-directory flow'),
    );
});
