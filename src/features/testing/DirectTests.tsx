import { Play, Square } from 'lucide-react';
import { parseDirectRequest } from '../../../shared/testing/direct';
import type { BoardTestsState } from './useBoardTests';
import { TestJsonEditor } from './TestJsonEditor';

export function DirectTests({
    tests: t,
    connected,
    collecting,
}: {
    tests: BoardTestsState;
    connected: boolean;
    collecting: boolean;
}) {
    let problem = '',
        count = 0;
    try {
        count = parseDirectRequest(t.directJson).testIds.length;
    } catch (e) {
        problem = e instanceof Error ? e.message : 'Invalid JSON request.';
    }
    return (
        <section className="panel test-panel" aria-label="JSON tests">
            <h2>Paste JSON. Run. Review results.</h2>
            <p>
                Paste a complete board profile or a request with profile, sequence or testIds, and
                optional fixtures. Run uses your declared mappings and prepared fixtures directly.
                Live collection and new terminal input pause during execution.
            </p>
            <p>
                Device checks and restoration still apply. LED output without a recorded physical
                observation is Inconclusive; this mode finishes without an observation prompt.
            </p>
            <TestJsonEditor
                label="Run request JSON"
                value={t.directJson}
                onChange={t.setDirectJson}
                disabled={t.locked}
                error={problem}
            />
            <div className="test-actions">
                <button
                    className="button primary"
                    disabled={
                        Boolean(problem) ||
                        t.locked ||
                        collecting ||
                        (!t.simulated && (!connected || !t.supported)) ||
                        (!t.historical && t.run?.phase === 'review')
                    }
                    onClick={() => void t.startJson()}
                >
                    <Play size={16} /> Run JSON
                </button>
                {t.active && (
                    <button
                        className="button danger"
                        disabled={t.working}
                        onClick={() => void t.cancel()}
                    >
                        <Square size={15} /> Cancel tests
                    </button>
                )}
                {!problem && <span>{count} tests selected</span>}
                {collecting && <span>Waiting for the current collection to finish.</span>}
            </div>
        </section>
    );
}
