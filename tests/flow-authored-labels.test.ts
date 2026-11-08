import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, scene } from '../src/features/automation/flow/model';
import {
    authoredLabelInput,
    authoredLabels,
    assertAuthoredLabelEntries,
    labelPositions,
    labelStamp,
} from './fixtures/flow-authored-labels';
test('authored source maps real snapshot state without inventing disabled evidence', () => {
    const input = authoredLabelInput(),
        before = structuredClone(input);
    const value = snapshot(input, true, labelStamp);
    assert.deepEqual(
        value.nodes.map((n) => [n.name, n.command, n.enabled, n.delay, n.status]),
        [
            [
                'Alpha & link',
                'printf ALPHA_17',
                true,
                'Delay 1 s before send',
                'Recorded: Exit 0 · run proofA01',
            ],
            ['Bravo <skip>', 'echo BRAVO_29', false, 'Delay 3 s before send', 'Disabled · skipped'],
        ],
    );
    const geometry = scene(value, labelPositions);
    assert.equal(geometry.width, 1000);
    assert.equal(geometry.graphHeight, 488);
    assert.deepEqual(
        geometry.nodes.map((n) => [n.ordinal, n.x, n.y]),
        [
            [1, 100, 220],
            [2, 480, 220],
        ],
    );
    assert.deepEqual(input, before);
});
const entries = () => authoredLabels.map(({ ordinal, role, text }) => ({ ordinal, role, text }));
test('all ten literal ordinal-role expectations match independently', () => {
    assert.equal(assertAuthoredLabelEntries(entries()).labels, 10);
});
test('swapped wrong and missing labels fail their intended literal checks', () => {
    const swapped = entries();
    [swapped[0].text, swapped[5].text] = [swapped[5].text, swapped[0].text];
    assert.throws(() => assertAuthoredLabelEntries(swapped), /1.name literal mismatch/);
    const wrong = entries();
    wrong[2].text = 'WRONG PAYLOAD ZZZZZ';
    assert.throws(() => assertAuthoredLabelEntries(wrong), /1.preview literal mismatch/);
    assert.throws(
        () =>
            assertAuthoredLabelEntries(
                entries().filter((e) => !(e.ordinal === 2 && e.role === 'intent')),
            ),
        /2.intent cardinality/,
    );
});
test('duplicates and unknown extra ordinal-role labels cannot pass', () => {
    assert.throws(
        () => assertAuthoredLabelEntries([...entries(), entries()[0]]),
        /1.name cardinality/,
    );
    assert.throws(
        () =>
            assertAuthoredLabelEntries([
                ...entries(),
                { ordinal: 99, role: 'name', text: 'extra' },
            ]),
        /unexpected graph labels/,
    );
});
