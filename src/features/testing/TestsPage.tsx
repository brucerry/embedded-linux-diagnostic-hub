import { useMemo, useRef } from 'react';
import {
    FlaskConical,
    Play,
    Square,
    FileInput,
    FileOutput,
    RefreshCw,
    ChevronDown,
    FileJson,
    FileCode,
    FileText,
    Wrench,
} from 'lucide-react';
import { ADAPTERS, validateProfile } from '../../../shared/testing/profile';
import { DOMAINS, type BoardTest } from '../../../shared/testing/types';
import type { BoardTestsState } from './useBoardTests';
import { Modal } from '../../components/Modal';
import { TestJsonEditor } from './TestJsonEditor';
import { DirectTests } from './DirectTests';
import { profileFieldErrors } from './validation';
import { createTestReport } from '../../../shared/testing/report';
import './testing.css';

interface Props {
    tests: BoardTestsState;
    connected: boolean;
    collecting: boolean;
    onConnect(): void;
}
export function TestsPage({ tests: t, connected, collecting, onConnect }: Props) {
    const profileInput = useRef<HTMLInputElement>(null),
        reportInput = useRef<HTMLInputElement>(null),
        preview = useRef<HTMLIFrameElement>(null);
    const { editor, setEditor } = t;
    const resultJson = useMemo(
        () =>
            t.run && !t.active
                ? JSON.stringify(createTestReport(t.run, t.historical), null, 4)
                : '',
        [t.run, t.active, t.historical],
    );
    const boardReady = Boolean(t.inventory?.complete);
    const fieldErrors = profileFieldErrors(t.profile, t.inventory);
    let jsonError = '';
    if (t.profile) {
        try {
            validateProfile(JSON.parse(t.json));
        } catch (e) {
            jsonError = e instanceof Error ? e.message : 'Invalid profile JSON.';
        }
    }
    const invalid = (key: string) => ({
        'aria-invalid': Boolean(fieldErrors[key]),
        'aria-describedby': fieldErrors[key] ? `test-field-${key}` : undefined,
    });
    const fieldError = (key: string) =>
        fieldErrors[key] ? (
            <small className="test-field-error" id={`test-field-${key}`}>
                {fieldErrors[key]}
            </small>
        ) : null;
    function updateTest(index: number, changes: Partial<BoardTest>) {
        if (!t.profile) return;
        const p = structuredClone(t.profile);
        p.tests[index] = { ...p.tests[index], ...changes };
        t.edit(p);
    }
    const selected = t.plan?.profile.sequences.find((s) => s.id === t.selection)?.tests ?? [
        t.selection,
    ];
    const readyToRun = Boolean(
        t.plan &&
        selected.length &&
        selected.every((id) => {
            const c = t.plan!.cases.find((c) => c.test.id === id);
            return c && !c.problems.length && t.readiness.fixtures[id]?.ready;
        }) &&
        t.readiness.reviewed &&
        !collecting &&
        !t.locked &&
        (t.historical || t.run?.phase !== 'review'),
    );
    return (
        <div className="testing-workspace">
            <section className="panel test-intro">
                <div>
                    <span className="subtle-badge">
                        {t.simulated
                            ? 'SIMULATED BOARD'
                            : t.historical
                              ? 'HISTORICAL TEST EVIDENCE'
                              : connected
                                ? 'CONNECTED DEVICE'
                                : 'NO DEVICE CONNECTED'}
                    </span>
                    <h2>
                        <FlaskConical size={22} /> Repeatable tests, tailored to your board.
                    </h2>
                    <p>
                        Map your resources once. Review the fixture and expected behavior, then run
                        an individual test or saved sequence.
                    </p>
                </div>
                <div className="test-actions">
                    {!connected && !t.simulated && (
                        <button className="button primary" onClick={onConnect}>
                            Connect device
                        </button>
                    )}
                    <button
                        type="button"
                        role="switch"
                        aria-label="Simulation mode"
                        aria-checked={t.simulated}
                        disabled={t.sourceLocked}
                        className="test-simulation-switch"
                        onClick={() => t.setSimulation(!t.simulated)}
                    >
                        <span className="test-switch-track" aria-hidden="true">
                            <span />
                        </span>
                        <span>Simulation</span>
                        <strong aria-hidden="true">{t.simulated ? 'On' : 'Off'}</strong>
                    </button>
                    {t.simulated && (
                        <label className="test-check">
                            <input
                                type="checkbox"
                                checked={t.fault}
                                disabled={t.locked || (!t.historical && t.run?.phase === 'review')}
                                onChange={(e) => t.setFault(e.target.checked)}
                            />{' '}
                            Simulate UART loopback failure
                        </label>
                    )}
                    <button
                        className="button secondary"
                        disabled={t.locked}
                        onClick={() => reportInput.current?.click()}
                    >
                        <FileInput size={16} /> Import test report
                    </button>
                </div>
                {!t.simulated && connected && !t.supported && (
                    <p role="status">
                        This connection does not support board testing. Update the application or
                        gateway; diagnostics and Terminal remain available.
                    </p>
                )}
                {t.simulated && (
                    <p className="test-source-note">
                        No hardware commands are sent. Simulated results do not qualify a physical
                        board.
                    </p>
                )}
                <div className="test-mode-switch" role="group" aria-label="Test input mode">
                    <button
                        className={`button ${t.mode === 'guided' ? 'primary' : 'secondary'}`}
                        aria-pressed={t.mode === 'guided'}
                        disabled={t.locked || (!t.historical && t.run?.phase === 'review')}
                        onClick={() => t.setMode('guided')}
                    >
                        <Wrench size={16} aria-hidden="true" /> Setup
                    </button>
                    <button
                        className={`button ${t.mode === 'json' ? 'primary' : 'secondary'}`}
                        aria-pressed={t.mode === 'json'}
                        disabled={t.locked || (!t.historical && t.run?.phase === 'review')}
                        onClick={() => t.setMode('json')}
                    >
                        <FileJson size={16} /> JSON
                    </button>
                </div>
            </section>
            {t.error && (
                <div className="error-banner" role="alert">
                    {t.error}
                </div>
            )}
            {t.notice && (
                <p className="test-notice" role="status">
                    {t.notice}
                </p>
            )}
            {t.mode === 'json' ? (
                <DirectTests tests={t} connected={connected} collecting={collecting} />
            ) : (
                <div className="test-setup-grid">
                    <section className="panel test-panel">
                        <div className="test-section-heading">
                            <h2>1. Board & resources</h2>
                            {!t.simulated && (
                                <button
                                    className="button secondary"
                                    disabled={
                                        t.locked || (!t.simulated && (!connected || !t.supported))
                                    }
                                    onClick={() => void t.discover()}
                                >
                                    <RefreshCw size={15} />{' '}
                                    {t.working ? 'Working…' : 'Discover board'}
                                </button>
                            )}
                        </div>
                        {t.inventory ? (
                            <>
                                <dl className="test-metadata">
                                    <div>
                                        <dt>Observed board</dt>
                                        <dd>{t.inventory.device.model || 'Unknown'}</dd>
                                    </div>
                                    <div>
                                        <dt>Kernel</dt>
                                        <dd>{t.inventory.device.kernel || 'Unknown'}</dd>
                                    </div>
                                    <div>
                                        <dt>Identity source</dt>
                                        <dd>
                                            {t.inventory.mode} · {t.inventory.nodes.length} DT nodes
                                        </dd>
                                    </div>
                                    <div>
                                        <dt>Discovery</dt>
                                        <dd>{t.inventory.complete ? 'Complete' : 'Incomplete'}</dd>
                                    </div>
                                </dl>
                                <div className="test-domain-list">
                                    {DOMAINS.map((domain) => (
                                        <div key={domain}>
                                            <strong>{domain.toUpperCase()}</strong>
                                            <span>
                                                {
                                                    t.inventory!.resources.filter(
                                                        (r) => r.domain === domain,
                                                    ).length
                                                }{' '}
                                                discovered
                                            </span>
                                            <small>
                                                {['led', 'uart', 'i2c'].includes(domain)
                                                    ? 'Test adapter available'
                                                    : 'Functional adapter not implemented'}
                                            </small>
                                        </div>
                                    ))}
                                </div>
                                {t.inventory.issues.length > 0 && (
                                    <p className="terminal-error">{t.inventory.issues.join(' ')}</p>
                                )}
                                <details>
                                    <summary>
                                        Observed resources and device-tree evidence{' '}
                                        <ChevronDown size={14} />
                                    </summary>
                                    <pre className="test-evidence">
                                        {JSON.stringify(
                                            {
                                                resources: t.inventory.resources,
                                                nodes: t.inventory.nodes,
                                            },
                                            null,
                                            2,
                                        )}
                                    </pre>
                                </details>
                            </>
                        ) : (
                            <p className="test-empty">
                                Discover the running board to resolve its device-tree and Linux
                                resources. Discovery only reads evidence.
                            </p>
                        )}
                    </section>
                    {boardReady && (
                        <section className="panel test-panel">
                            <div className="test-section-heading">
                                <h2>2. Project profile</h2>
                                <div className="test-actions">
                                    <button
                                        className="button secondary"
                                        disabled={t.locked}
                                        onClick={() => setEditor(!editor)}
                                    >
                                        {editor ? 'Hide' : 'Show'} advanced JSON editor
                                    </button>
                                    <button
                                        className="button secondary"
                                        disabled={t.locked}
                                        onClick={() => profileInput.current?.click()}
                                    >
                                        <FileInput size={15} /> Import profile
                                    </button>
                                    <button
                                        className="button secondary"
                                        disabled={t.locked || !t.profile}
                                        onClick={t.exportProfile}
                                    >
                                        <FileOutput size={15} /> Export profile
                                    </button>
                                </div>
                            </div>
                            {editor && (
                                <TestJsonEditor
                                    label="Profile JSON"
                                    value={t.json}
                                    onChange={t.setJson}
                                    disabled={t.locked}
                                    error={jsonError}
                                />
                            )}
                            {!editor && jsonError && (
                                <p className="test-field-error" role="alert">
                                    {jsonError}
                                </p>
                            )}
                            {t.profile ? (
                                <fieldset
                                    disabled={t.locked || (t.jsonEdited && Boolean(jsonError))}
                                    className="test-fields"
                                >
                                    <label>
                                        Profile name
                                        <input
                                            {...invalid('name')}
                                            value={t.profile.name}
                                            onChange={(e) =>
                                                t.edit({ ...t.profile!, name: e.target.value })
                                            }
                                        />
                                        {fieldError('name')}
                                    </label>
                                    <div className="test-field-pair">
                                        <label>
                                            Profile revision
                                            <input
                                                {...invalid('revision')}
                                                value={t.profile.revision}
                                                onChange={(e) =>
                                                    t.edit({
                                                        ...t.profile!,
                                                        revision: e.target.value,
                                                    })
                                                }
                                            />
                                            {fieldError('revision')}
                                        </label>
                                        <label>
                                            Declared board revision
                                            <input
                                                {...invalid('boardRevision')}
                                                value={t.profile.boardRevision}
                                                onChange={(e) =>
                                                    t.edit({
                                                        ...t.profile!,
                                                        boardRevision: e.target.value,
                                                    })
                                                }
                                            />
                                            {fieldError('boardRevision')}
                                        </label>
                                    </div>
                                    <label>
                                        Expected board model
                                        <input
                                            {...invalid('match.model')}
                                            value={t.profile.match.model}
                                            onChange={(e) =>
                                                t.edit({
                                                    ...t.profile!,
                                                    match: {
                                                        ...t.profile!.match,
                                                        model: e.target.value,
                                                    },
                                                })
                                            }
                                        />
                                        {fieldError('match.model')}
                                    </label>
                                    <label>
                                        Expected compatible identity
                                        <input
                                            {...invalid('match.compatible')}
                                            value={t.profile.match.compatible}
                                            onChange={(e) =>
                                                t.edit({
                                                    ...t.profile!,
                                                    match: {
                                                        ...t.profile!.match,
                                                        compatible: e.target.value,
                                                    },
                                                })
                                            }
                                        />
                                        {fieldError('match.compatible')}
                                    </label>
                                    <label className="test-check">
                                        <input
                                            {...invalid('match.manual')}
                                            type="checkbox"
                                            checked={t.profile.match.manual}
                                            onChange={(e) =>
                                                t.edit({
                                                    ...t.profile!,
                                                    match: {
                                                        ...t.profile!.match,
                                                        manual: e.target.checked,
                                                    },
                                                })
                                            }
                                        />{' '}
                                        Review manual mappings when board identity is unavailable
                                        {fieldError('match.manual')}
                                    </label>
                                    {t.profile.tests.map((test, index) => (
                                        <details
                                            className="test-definition"
                                            key={test.id}
                                            open={
                                                t.profile!.tests.length <= 3 ||
                                                Object.keys(fieldErrors).some((key) =>
                                                    key.startsWith(`tests.${index}.`),
                                                )
                                            }
                                        >
                                            <summary>
                                                {test.name} <small>{test.adapter}</small>
                                            </summary>
                                            <div className="test-fields">
                                                <label>
                                                    Test name
                                                    <input
                                                        {...invalid(`tests.${index}.name`)}
                                                        value={test.name}
                                                        onChange={(e) =>
                                                            updateTest(index, {
                                                                name: e.target.value,
                                                            })
                                                        }
                                                    />
                                                    {fieldError(`tests.${index}.name`)}
                                                </label>
                                                <label>
                                                    Logical resource
                                                    <select
                                                        {...invalid(`tests.${index}.resource`)}
                                                        value={test.resource}
                                                        onChange={(e) =>
                                                            updateTest(index, {
                                                                resource: e.target.value,
                                                            })
                                                        }
                                                    >
                                                        {t
                                                            .profile!.resources.filter(
                                                                (r) =>
                                                                    r.domain ===
                                                                    ADAPTERS[test.adapter].domain,
                                                            )
                                                            .map((r) => (
                                                                <option key={r.id} value={r.id}>
                                                                    {r.id}
                                                                </option>
                                                            ))}
                                                    </select>
                                                    {fieldError(`tests.${index}.resource`)}
                                                </label>
                                                <label>
                                                    Mapped runtime resource
                                                    <select
                                                        {...invalid(`tests.${index}.mapping`)}
                                                        value={
                                                            t.inventory?.resources.find(
                                                                (r) =>
                                                                    r.domain ===
                                                                        ADAPTERS[test.adapter]
                                                                            .domain &&
                                                                    Object.keys(
                                                                        t.profile!.resources.find(
                                                                            (x) =>
                                                                                x.id ===
                                                                                test.resource,
                                                                        )!.selector,
                                                                    ).length > 0 &&
                                                                    Object.entries(
                                                                        t.profile!.resources.find(
                                                                            (x) =>
                                                                                x.id ===
                                                                                test.resource,
                                                                        )!.selector,
                                                                    ).every(
                                                                        ([key, value]) =>
                                                                            (
                                                                                r as unknown as Record<
                                                                                    string,
                                                                                    unknown
                                                                                >
                                                                            )[key] === value,
                                                                    ),
                                                            )?.id || ''
                                                        }
                                                        onChange={(e) => {
                                                            const r = t.inventory?.resources.find(
                                                                    (r) => r.id === e.target.value,
                                                                ),
                                                                p = structuredClone(t.profile!);
                                                            if (r)
                                                                p.resources.find(
                                                                    (x) => x.id === test.resource,
                                                                )!.selector = r.ofNode
                                                                    ? {
                                                                          ofNode: r.ofNode,
                                                                          ...(r.domain === 'led'
                                                                              ? { name: r.name }
                                                                              : {}),
                                                                          ...(r.address !== null
                                                                              ? {
                                                                                    address:
                                                                                        r.address,
                                                                                }
                                                                              : {}),
                                                                      }
                                                                    : { path: r.path };
                                                            t.edit(p);
                                                        }}
                                                    >
                                                        <option value="">
                                                            Choose an observed resource
                                                        </option>
                                                        {t.inventory?.resources
                                                            .filter(
                                                                (r) =>
                                                                    r.domain ===
                                                                    ADAPTERS[test.adapter].domain,
                                                            )
                                                            .map((r) => (
                                                                <option key={r.id} value={r.id}>
                                                                    {r.name} · {r.path}
                                                                </option>
                                                            ))}
                                                    </select>
                                                    {fieldError(`tests.${index}.mapping`)}
                                                </label>
                                                <label>
                                                    Fixture / observer requirement
                                                    <textarea
                                                        {...invalid(`tests.${index}.fixture`)}
                                                        rows={2}
                                                        value={test.fixture}
                                                        onChange={(e) =>
                                                            updateTest(index, {
                                                                fixture: e.target.value,
                                                            })
                                                        }
                                                    />
                                                    {fieldError(`tests.${index}.fixture`)}
                                                </label>
                                                <label>
                                                    Expected behavior
                                                    <textarea
                                                        {...invalid(`tests.${index}.expected`)}
                                                        rows={2}
                                                        value={test.expected}
                                                        onChange={(e) =>
                                                            updateTest(index, {
                                                                expected: e.target.value,
                                                            })
                                                        }
                                                    />
                                                    {fieldError(`tests.${index}.expected`)}
                                                </label>
                                                <div className="test-parameter-grid">
                                                    {Object.entries(test.parameters).map(
                                                        ([key, value]) => (
                                                            <label key={key}>
                                                                {key === 'level'
                                                                    ? 'Brightness level'
                                                                    : key === 'intervalMs'
                                                                      ? 'Interval (ms)'
                                                                      : key === 'timeoutMs'
                                                                        ? 'Timeout (ms)'
                                                                        : key === 'register'
                                                                          ? 'Approved register (decimal)'
                                                                          : key === 'expected'
                                                                            ? 'Expected byte (decimal)'
                                                                            : key === 'mask'
                                                                              ? 'Comparison mask (decimal)'
                                                                              : key === 'baud'
                                                                                ? 'Baud rate'
                                                                                : key === 'payload'
                                                                                  ? 'Payload'
                                                                                  : 'Cycles'}
                                                                <input
                                                                    {...invalid(
                                                                        `tests.${index}.parameters.${key}`,
                                                                    )}
                                                                    type={
                                                                        key === 'payload'
                                                                            ? 'text'
                                                                            : 'number'
                                                                    }
                                                                    value={value ?? ''}
                                                                    onChange={(e) =>
                                                                        updateTest(index, {
                                                                            parameters: {
                                                                                ...test.parameters,
                                                                                [key]:
                                                                                    key ===
                                                                                    'payload'
                                                                                        ? e.target
                                                                                              .value
                                                                                        : e.target
                                                                                                .value ===
                                                                                            ''
                                                                                          ? null
                                                                                          : Number(
                                                                                                e
                                                                                                    .target
                                                                                                    .value,
                                                                                            ),
                                                                            },
                                                                        })
                                                                    }
                                                                />
                                                                {fieldError(
                                                                    `tests.${index}.parameters.${key}`,
                                                                )}
                                                            </label>
                                                        ),
                                                    )}
                                                </div>
                                                <label className="test-check">
                                                    <input
                                                        type="checkbox"
                                                        checked={test.required}
                                                        onChange={(e) =>
                                                            updateTest(index, {
                                                                required: e.target.checked,
                                                            })
                                                        }
                                                    />{' '}
                                                    Required for overall pass
                                                </label>
                                            </div>
                                        </details>
                                    ))}
                                </fieldset>
                            ) : (
                                <p className="test-empty">
                                    Import a project profile, discover a board, or try the simulated
                                    example to begin.
                                </p>
                            )}
                            <button
                                className="button primary"
                                disabled={
                                    t.locked ||
                                    !boardReady ||
                                    !t.profile ||
                                    Boolean(jsonError) ||
                                    Object.keys(fieldErrors).length > 0 ||
                                    !t.profile.tests.length
                                }
                                onClick={() => void t.prepare()}
                            >
                                Validate & prepare tests
                            </button>
                        </section>
                    )}
                </div>
            )}
            {t.mode === 'guided' && boardReady && t.plan && (
                <section className="panel test-panel">
                    <h2>3. Review & run</h2>
                    <p>
                        Only the selected approved resources will be exercised. Live diagnostics and
                        new terminal input pause during testing; already-running programs and other
                        clients can still affect the device.
                    </p>
                    <label>
                        Test or sequence
                        <select
                            aria-label="Test or sequence"
                            value={t.selection}
                            disabled={t.locked}
                            onChange={(e) => t.setSelection(e.target.value)}
                        >
                            <optgroup label="Saved sequences">
                                {t.plan.profile.sequences.map((s) => (
                                    <option key={s.id} value={s.id}>
                                        {s.name}
                                    </option>
                                ))}
                            </optgroup>
                            <optgroup label="Individual tests">
                                {t.plan.profile.tests.map((test) => (
                                    <option key={test.id} value={test.id}>
                                        {test.name}
                                    </option>
                                ))}
                            </optgroup>
                        </select>
                    </label>
                    <div className="test-plan-list">
                        {t.plan.cases
                            .filter((c) => selected.includes(c.test.id))
                            .map((c) => (
                                <article key={c.test.id}>
                                    <h3>{c.test.name}</h3>
                                    <code>{c.resource?.path || 'Resource not resolved'}</code>
                                    <p>{c.effects}</p>
                                    <p>
                                        <strong>Expected:</strong>{' '}
                                        {c.test.expected || 'Not configured'}
                                    </p>
                                    <p>
                                        <strong>Fixture:</strong>{' '}
                                        {c.test.fixture || 'Not configured'}
                                    </p>
                                    {c.problems.length > 0 && (
                                        <p className="terminal-error">
                                            Blocked: {c.problems.join(' ')}
                                        </p>
                                    )}
                                    <div className="test-field-pair">
                                        <label className="test-check">
                                            <input
                                                aria-invalid={
                                                    !t.readiness.fixtures[c.test.id]?.ready
                                                }
                                                type="checkbox"
                                                disabled={t.locked || c.problems.length > 0}
                                                checked={
                                                    t.readiness.fixtures[c.test.id]?.ready || false
                                                }
                                                onChange={(e) =>
                                                    t.setReadiness({
                                                        ...t.readiness,
                                                        fixtures: {
                                                            ...t.readiness.fixtures,
                                                            [c.test.id]: {
                                                                ...t.readiness.fixtures[c.test.id],
                                                                ready: e.target.checked,
                                                            },
                                                        },
                                                    })
                                                }
                                            />{' '}
                                            Fixture / observer ready
                                        </label>
                                        <label>
                                            Fixture identity (optional)
                                            <input
                                                disabled={t.locked}
                                                value={
                                                    t.readiness.fixtures[c.test.id]?.identity || ''
                                                }
                                                onChange={(e) =>
                                                    t.setReadiness({
                                                        ...t.readiness,
                                                        fixtures: {
                                                            ...t.readiness.fixtures,
                                                            [c.test.id]: {
                                                                ...t.readiness.fixtures[c.test.id],
                                                                identity: e.target.value,
                                                            },
                                                        },
                                                    })
                                                }
                                            />
                                        </label>
                                    </div>
                                </article>
                            ))}
                    </div>
                    <label className="test-check">
                        <input
                            aria-invalid={!t.readiness.reviewed}
                            type="checkbox"
                            disabled={t.locked}
                            checked={t.readiness.reviewed}
                            onChange={(e) =>
                                t.setReadiness({ ...t.readiness, reviewed: e.target.checked })
                            }
                        />{' '}
                        I reviewed the mappings, expected results and fixture requirements, and
                        prepared the device for exclusive test use.
                    </label>
                    <div className="test-actions">
                        <button
                            className="button primary"
                            disabled={!readyToRun}
                            onClick={() => void t.start()}
                        >
                            <Play size={16} /> Run selected tests
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
                        {collecting && <span>Waiting for the current collection to finish.</span>}
                    </div>
                </section>
            )}
            {t.run && (
                <section className="panel test-panel" aria-label="Test run results">
                    <div className="test-section-heading">
                        <div>
                            <span className="subtle-badge">
                                {t.run.mode === 'simulated'
                                    ? `SIMULATED EVIDENCE${t.historical ? ' · HISTORICAL' : ''}`
                                    : t.historical
                                      ? 'IMPORTED / HISTORICAL EVIDENCE'
                                      : 'SSH TEST EVIDENCE'}
                            </span>
                            <h2>
                                Test results{' '}
                                <span className={`test-verdict ${t.run.verdict.toLowerCase()}`}>
                                    {t.run.verdict}
                                </span>
                            </h2>
                            <p role="status">
                                {t.active
                                    ? `${t.run.cases.filter((c) => c.status === 'done').length} / ${t.run.cases.length} tests complete`
                                    : `Run ${t.run.phase}`}{' '}
                                {t.run.interruption && `· ${t.run.interruption}`}
                            </p>
                        </div>
                        <div className="test-actions">
                            {(['json', 'html', 'pdf'] as const).map((format) => (
                                <button
                                    key={format}
                                    className="button secondary"
                                    disabled={t.working || t.active}
                                    onClick={() => void t.exportReport(format)}
                                >
                                    {format === 'json' ? (
                                        <FileJson size={16} />
                                    ) : format === 'html' ? (
                                        <FileCode size={16} />
                                    ) : (
                                        <FileText size={16} />
                                    )}
                                    {format === 'pdf' && !window.diagnosticHub?.exportTestReport
                                        ? 'Print / Save PDF'
                                        : `Export ${format.toUpperCase()}`}
                                </button>
                            ))}
                        </div>
                    </div>
                    {t.mode === 'json' && resultJson && (
                        <TestJsonEditor label="Result report JSON" value={resultJson} readOnly />
                    )}
                    <div className="test-result-list">
                        {t.run.cases.map((c) => (
                            <article key={c.test.id}>
                                <div className="test-section-heading">
                                    <h3>{c.test.name}</h3>
                                    <span className={`test-verdict ${c.verdict.toLowerCase()}`}>
                                        {c.status === 'running' ? 'Running' : c.verdict}
                                    </span>
                                </div>
                                <p>{c.reason}</p>
                                <dl className="test-metadata">
                                    <div>
                                        <dt>Expected</dt>
                                        <dd>{c.test.expected}</dd>
                                    </div>
                                    <div>
                                        <dt>Observed</dt>
                                        <dd>{c.evidence?.measured ?? 'Not obtained'}</dd>
                                    </div>
                                    <div>
                                        <dt>Resolved resource</dt>
                                        <dd>{c.resource?.path || 'Unresolved'}</dd>
                                    </div>
                                    <div>
                                        <dt>Cleanup</dt>
                                        <dd>
                                            {c.evidence
                                                ? `${c.evidence.cleanup} · ${c.evidence.cleanupDetail}`
                                                : 'Not executed'}
                                        </dd>
                                    </div>
                                </dl>
                                {!t.historical &&
                                    !t.active &&
                                    c.test.adapter === 'led.pattern' &&
                                    c.evidence?.execution === 'ok' &&
                                    !c.feedback && (
                                        <div className="test-observation">
                                            <p>Did the LED display the expected pattern?</p>
                                            <div className="test-actions">
                                                <button
                                                    className="button primary"
                                                    disabled={t.working}
                                                    onClick={() => void t.confirm(c.test.id, 'yes')}
                                                >
                                                    Yes, expected pattern
                                                </button>
                                                <button
                                                    className="button secondary"
                                                    disabled={t.working}
                                                    onClick={() => void t.confirm(c.test.id, 'no')}
                                                >
                                                    No, different behavior
                                                </button>
                                                <button
                                                    className="button secondary"
                                                    disabled={t.working}
                                                    onClick={() =>
                                                        void t.confirm(c.test.id, 'unobserved')
                                                    }
                                                >
                                                    Not observed
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                {c.feedback && (
                                    <p>
                                        Operator observation: {c.feedback.value} · {c.feedback.at}
                                    </p>
                                )}
                                <details>
                                    <summary>Raw test evidence</summary>
                                    <pre className="test-evidence">
                                        {c.evidence?.stdout || '(No output)'}
                                        {c.evidence?.stderr
                                            ? `\nStandard error:\n${c.evidence.stderr}`
                                            : ''}
                                    </pre>
                                    {c.evidence?.truncated && <p>Output was truncated.</p>}
                                </details>
                            </article>
                        ))}
                    </div>
                    {!t.historical && t.run.phase === 'review' && (
                        <button
                            className="button secondary"
                            disabled={t.working}
                            onClick={() => void t.cancel()}
                        >
                            Dismiss remaining observations
                        </button>
                    )}
                </section>
            )}
            <input
                className="visually-hidden"
                ref={profileInput}
                type="file"
                accept=".json,application/json"
                aria-label="Import board profile"
                onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void t.importProfile(file);
                    e.target.value = '';
                }}
            />
            <input
                className="visually-hidden"
                ref={reportInput}
                type="file"
                accept=".json,application/json"
                aria-label="Import test JSON report"
                onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void t.importReport(file);
                    e.target.value = '';
                }}
            />
            {t.preview && (
                <Modal title="Test report preview" wide onClose={() => t.setPreview(null)}>
                    <p>
                        Use your browser’s print dialog and choose Save as PDF. The report stays on
                        your PC.
                    </p>
                    <button
                        className="button primary"
                        onClick={() => preview.current?.contentWindow?.print()}
                    >
                        Print / Save PDF
                    </button>
                    <iframe
                        ref={preview}
                        className="test-report-preview"
                        title="Print-ready test report"
                        sandbox="allow-same-origin allow-modals"
                        srcDoc={t.preview}
                    />
                </Modal>
            )}
        </div>
    );
}
