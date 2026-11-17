// Static workflow/source data only; no shell, worker, action, network or browser runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const workflowURL = new URL('../.github/workflows/web-public-baseline.yml', import.meta.url);
const branch = 'ci/v060-web-sandbox-baseline-20261117';
const checkout = 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803';
const phases = ['host', 'preparation', 'runtime'];
function parse(text) {
    return yaml.load(text, { schema: yaml.JSON_SCHEMA });
}
const original = () => parse(readFileSync(workflowURL, 'utf8'));
const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), [...expected].sort());
function inspect(value) {
    keys(value, ['name', 'on', 'permissions', 'concurrency', 'env', 'jobs']);
    assert.deepEqual(value.on, { push: { branches: [branch] } });
    assert.deepEqual(value.permissions, { contents: 'read' });
    assert.deepEqual(value.concurrency, {
        group: 'web-public-baseline-${{ github.ref }}',
        'cancel-in-progress': false,
    });
    assert.deepEqual(value.env, {
        BASH_ENV: '/dev/null',
        ENV: '/dev/null',
        NODE_OPTIONS: '',
        NODE_PATH: '',
        NODE_COMPILE_CACHE: '',
        NODE_V8_COVERAGE: '',
        NODE_DISABLE_COMPILE_CACHE: '1',
        ESBUILD_BINARY_PATH: '',
        LD_PRELOAD: '',
        LD_LIBRARY_PATH: '',
        PYTHONPATH: '',
        PYTHONHOME: '',
    });
    keys(value.jobs, ['web_baseline']);
    const job = value.jobs.web_baseline;
    keys(job, ['if', 'runs-on', 'timeout-minutes', 'defaults', 'steps']);
    assert.equal(
        job.if.replace(/\s+/g, ' ').trim(),
        "${{ github.repository == 'brucerry/embedded-linux-diagnostic-hub' && github.event.repository.private == false && github.event_name == 'push' && github.ref == 'refs/heads/" +
            branch +
            "' && github.run_attempt == 1 }}",
    );
    assert.equal(job['runs-on'], 'ubuntu-24.04');
    assert.equal(job['timeout-minutes'], 20);
    assert.deepEqual(job.defaults, {
        run: { shell: '/usr/bin/bash --noprofile --norc -euo pipefail {0}' },
    });
    assert.equal(job.steps.length, 12);
    const uses = job.steps.filter((s) => s.uses);
    assert.equal(uses.length, 1);
    assert.equal(uses[0].uses, checkout);
    assert.deepEqual(uses[0].with, {
        ref: '${{ github.sha }}',
        'fetch-depth': 1,
        'persist-credentials': false,
        clean: false,
        'set-safe-directory': false,
        submodules: false,
        lfs: false,
    });
    for (const step of job.steps) {
        assert.ok(
            !Object.hasOwn(step, 'continue-on-error') && !Object.hasOwn(step, 'timeout-minutes'),
        );
        assert.ok(!/\$\{\{\s*(?:secrets|vars)\./.test(JSON.stringify(step)));
        assert.ok(
            !/\b(?:sudo|chmod|chown|curl|wget|npx|kill|rmdir)\b|\brm\s|\bnpm\s+(?:install|ci)\b|--no-sandbox/.test(
                step.run ?? '',
            ),
        );
    }
    const selected = (id) => job.steps.find((s) => s.id === id);
    assert.equal(
        selected('captures').run,
        '/usr/bin/python3 -I -B scripts/ci/report-web-baseline.py --phase initialize',
    );
    assert.ok(job.steps.indexOf(selected('captures')) < job.steps.indexOf(selected('host')));
    assert.ok(job.steps.indexOf(selected('host')) < job.steps.indexOf(selected('preparation')));
    assert.ok(job.steps.indexOf(selected('preparation')) < job.steps.indexOf(selected('runtime')));
    for (const phase of phases) {
        const worker = selected(phase),
            collector = selected(phase + '_report');
        assert.equal(worker.if, '${{ success() }}');
        assert.ok(worker.run.includes('umask 077\nset -o noclobber\n'));
        assert.ok(worker.run.includes('set +e\n'));
        assert.ok(
            worker.run.endsWith(
                'worker_exit=$?\nset -e\nprintf \'%s\\n\' "$worker_exit" > "$capture/' +
                    phase +
                    '.exit-code"\nexit "$worker_exit"\n',
            ),
        );
        assert.ok(
            worker.run.includes(
                '> "$capture/' + phase + '.stdout" 2> "$capture/' + phase + '.stderr"',
            ),
        );
        assert.equal(collector.if, '${{ always() }}');
        assert.deepEqual(collector.env, {
            WEB_WORKER_OUTCOME: '${{ steps.' + phase + '.outcome }}',
        });
        assert.equal(
            collector.run,
            '/usr/bin/python3 -I -B scripts/ci/report-web-baseline.py --phase ' + phase,
        );
        const guard = job.steps[job.steps.indexOf(collector) + 1];
        assert.equal(guard.if, '${{ always() }}');
        assert.ok(guard.name.includes('${{ steps.' + phase + '.outcome }}'));
        for (const field of ['result', 'stage', 'closure']) {
            assert.ok(
                guard.name.includes(
                    'steps.' +
                        phase +
                        "_report.outcome == 'success' && steps." +
                        phase +
                        '_report.outputs.' +
                        field,
                ),
            );
        }
        assert.deepEqual(guard.env, {
            WORKER_OUTCOME: '${{ steps.' + phase + '.outcome }}',
            REPORT_OUTCOME: '${{ steps.' + phase + '_report.outcome }}',
            REPORT_RESULT: '${{ steps.' + phase + "_report.outputs.result || 'unavailable' }}",
        });
        assert.equal(
            guard.run,
            'test "$WORKER_OUTCOME" = success\ntest "$REPORT_OUTCOME" = success\ntest "$REPORT_RESULT" = passed\n',
        );
    }
    const runtime = selected('runtime').run;
    assert.ok(runtime.includes('/usr/bin/env -i \\\n'));
    assert.ok(
        !runtime.includes('GITHUB_OUTPUT=') &&
            !runtime.includes('TOKEN=') &&
            !runtime.includes('SSH_'),
    );
    assert.ok(
        runtime.includes('"$RUNNER_TEMP/web-baseline-inputs-$GITHUB_RUN_ID-1/node/bin/node"'),
    );
    assert.ok(runtime.includes('scripts/ci/run-web-baseline.mjs'));
    return { runner: job['runs-on'], jobs: 1, phases: [...phases], qualification: 'static-only' };
}

test('actual public workflow is one exact branch, least-privilege, bounded same-job baseline', () => {
    assert.deepEqual(inspect(original()), {
        runner: 'ubuntu-24.04',
        jobs: 1,
        phases,
        qualification: 'static-only',
    });
});
test('additional triggers, jobs, privilege and runner substitutions are refused as static data', () => {
    for (const change of ['dispatch', 'pull-request', 'job', 'permission', 'runner']) {
        const v = original();
        if (change === 'dispatch') v.on.workflow_dispatch = {};
        if (change === 'pull-request') v.on.pull_request = {};
        if (change === 'job') v.jobs.another = {};
        if (change === 'permission') v.permissions['id-token'] = 'write';
        if (change === 'runner') v.jobs.web_baseline['runs-on'] = 'self-hosted';
        assert.throws(() => inspect(v));
    }
});
test('startup isolation and pinned non-persisting checkout remain mandatory', () => {
    for (const change of ['startup', 'action', 'persist']) {
        const v = original();
        if (change === 'startup') delete v.env.BASH_ENV;
        if (change === 'action')
            v.jobs.web_baseline.steps.find((s) => s.uses).uses = 'actions/checkout@main';
        if (change === 'persist')
            v.jobs.web_baseline.steps.find((s) => s.uses).with['persist-credentials'] = true;
        assert.throws(() => inspect(v));
    }
});
test('host checks precede acquisition and all three workers preserve their original exit', () => {
    const v = original();
    const steps = v.jobs.web_baseline.steps;
    const host = steps.find((s) => s.id === 'host');
    host.run = host.run.replace('exit "$worker_exit"', 'exit 0');
    assert.throws(() => inspect(v));
    const moved = original();
    const at = moved.jobs.web_baseline.steps.findIndex((s) => s.id === 'host');
    const [worker] = moved.jobs.web_baseline.steps.splice(at, 1);
    moved.jobs.web_baseline.steps.push(worker);
    assert.throws(() => inspect(moved));
});
test('metadata fields cannot override a failed worker or collector acknowledgement', () => {
    for (const label of ['WORKER_OUTCOME', 'REPORT_OUTCOME']) {
        const v = original();
        const at = v.jobs.web_baseline.steps.findIndex((s) => s.id === 'runtime_report');
        v.jobs.web_baseline.steps[at + 1].run = v.jobs.web_baseline.steps[at + 1].run.replace(
            'test "$' + label + '" = success\n',
            '',
        );
        assert.throws(() => inspect(v));
    }
});
test('the existing actor still uses fixed sandboxed Chrome, version match and archive-only loopback UI', () => {
    const source = readFileSync(
        new URL('../scripts/lib/web-baseline-driver.mjs', import.meta.url),
        'utf8',
    );
    assert.ok(source.includes("version: '157.0.8103.50'"));
    assert.ok(source.includes("chrome: '/opt/google/chrome/chrome'"));
    assert.ok(source.includes("driver: '/usr/local/share/chromedriver-linux64/chromedriver'"));
    assert.ok(source.includes("'--headless=new'"));
    assert.ok(!source.includes("'--no-sandbox'"));
    assert.ok(source.includes('created.capabilities.browserVersion, WEB_BASELINE_HOST.version'));
    assert.ok(source.includes("'http://127.0.0.1") || source.includes('^http:\\/\\/127'));
    assert.ok(source.includes('ports.archive.revalidate()'));
    assert.ok(source.includes("'DELETE', '/session/' + session"));
    assert.ok(source.includes("'GET', '/shutdown'"));
});
test('YAML parser rejects duplicate workflow keys without executing any mutated fixture', () => {
    assert.throws(() => parse('name: harmless\nname: duplicate\n'));
});
