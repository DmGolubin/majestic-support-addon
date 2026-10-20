"""Real-time soak; --smoke never claims hour/900-second refresh coverage."""
import json
import math
import time
from memory_common import parser, configure, Run, CYCLE_JS, check, save, cleanup_assertions

p = parser('Offline BetterDiscord real-time soak, with immutable bundle provenance')
p.add_argument('--seconds', type=int, default=3600)
p.add_argument('--cycles', type=int, default=1000)
p.add_argument('--sample-seconds', type=int, default=30)
p.add_argument('--smoke', action='store_true')
p.add_argument('--source-fixed', action='store_true', help='Operator confirms parent source-fixed signal was received')
p.add_argument('--expected-sha256', help='Required for final hour; must match the prepared plugin')
p.add_argument('--heap-growth-mib', type=float, default=2)
p.add_argument('--dom-growth', type=int, default=10)
p.add_argument('--listener-growth', type=int, default=5)
p.add_argument('--idle-cpu-percent', type=float, default=1)
args = p.parse_args()
if not 5 <= args.sample_seconds <= 45 or args.seconds < 10 or args.cycles < 1:
    p.error('Use 5..45 second sampling, duration >=10 and positive cycles')
if args.smoke:
    if args.seconds > 180:
        p.error('Smoke must be <=180 seconds')
elif args.seconds < 3600 or args.cycles < 1000 or not args.source_fixed or not args.expected_sha256:
    p.error('Final soak requires >=3600 seconds, >=1000 cycles, --source-fixed and --expected-sha256')
name = 'soak-results.json'
result = configure(args, name)
if args.expected_sha256 and args.expected_sha256 != result['provenance']['pluginSha256']:
    p.error('Expected bundle SHA-256 does not match harness')
if not args.smoke and not (result['provenance'].get('buildEvidenceMatchesBundle') and result['provenance'].get('worktreeMatchesBuildInputs')):
    p.error('Final soak needs matching build evidence and source inputs; prepare again after the parent build')
result.update(mode='smoke' if args.smoke else 'hour', requestedSeconds=args.seconds, requestedCycles=args.cycles,
              sourceFixedAcknowledged=args.source_fixed, sampleSeconds=args.sample_seconds, events=[], idleIntervals=[],
              oauthLifetimeSeconds=900, clock='real Date.now and monotonic; no fake clocks', completedCycles=0,
              limits={'heapGrowthMiB':args.heap_growth_mib,'domGrowth':args.dom_growth,'listenerGrowth':args.listener_growth,
                      'idleMainThreadPercent':args.idle_cpu_percent},
              coverage={'oauth900s': 'not exercised in smoke' if args.smoke else 'pending',
                        'nativeProtectedStorage':False,'realDiscord':False})
started = time.monotonic()
try:
    with Run(args, result) as run:
        page, cdp = run.fresh()
        def emergency_cleanup():
            if result.get('cleanupCompleted'):
                return
            try:
                run.stop(page)
                row = run.measure(page, cdp, 'failure-stopped', result['completedCycles'])
                result['samples'].append(row)
                cleanup_assertions(result, row)
                result['cleanupCompleted'] = True
            except Exception as cleanup_error:
                result['cleanupError'] = str(cleanup_error)
        run.stack.callback(emergency_cleanup)
        run.connect(page)
        page.evaluate(CYCLE_JS, 10 if args.smoke else 20)
        baseline = run.measure(page, cdp, 'warmup-closed', 0)
        result['warmupCyclesExcluded'] = 10 if args.smoke else 20
        result['samples'].append(baseline)
        result['baseline'] = baseline
        save(args, name, result)
        soak_start = time.monotonic()
        previous = None
        activity = 0
        mode = 'closed'
        current_phase = 'actions'
        next_sample = 0
        blocks = 2 if args.smoke else 20
        block_seconds = args.seconds / blocks
        outages = [args.seconds * .35] if args.smoke else [300, 1800]
        outage_duration = min(3, args.seconds / 10) if args.smoke else 20
        active_outage = None
        recovery = None
        closed_samples = []
        def sample(label):
            global previous
            row = run.measure(page, cdp, label, result['completedCycles'])
            row.update(soakElapsed=time.monotonic()-soak_start, phase=current_phase, idleMode=mode, activityRevision=activity)
            if previous and previous['phase'] == current_phase == 'idle' and previous['idleMode'] == mode and previous['activityRevision'] == activity:
                seconds = row['beforeGC']['Timestamp'] - previous['afterGC']['Timestamp']
                task = row['beforeGC']['TaskDuration'] - previous['afterGC']['TaskDuration']
                interval = {'mode': mode, 'seconds': seconds, 'taskSeconds': task, 'mainThreadPercent': task / seconds * 100 if seconds else 0}
                result['idleIntervals'].append(interval)
                if seconds >= 5:
                    check(result, 'idle-cpu-' + mode, interval['mainThreadPercent'] <= args.idle_cpu_percent, interval)
            previous = row
            result['samples'].append(row)
            app = row['app']
            check(result, 'one-runtime-root', app['roots'] == 1, app['roots'])
            check(result, 'one-toolbar-mount', app['mounts'] == 1, app['mounts'])
            check(result, 'at-most-one-stream', app['host']['streams'] <= 1, app['host']['streams'])
            check(result, 'no-invalid-refresh', app['fixture']['rejectedRefresh'] == 0, app['fixture']['rejectedRefresh'])
            check(result, 'fixture-origin-enforced', app['fixture']['deniedDestinations'] == 0)
            if app['windows'] == 0 and current_phase != 'network':
                closed_samples.append(row)
                check(result, 'closed-dom-bounded', row['dom']['nodes'] <= baseline['dom']['nodes'] + args.dom_growth, row['dom']['nodes'])
                check(result, 'closed-listeners-bounded', row['dom']['jsEventListeners'] <= baseline['dom']['jsEventListeners'] + args.listener_growth, row['dom']['jsEventListeners'])
                check(result, 'closed-heap-bounded', row['heap']['usedSize'] <= baseline['heap']['usedSize'] + args.heap_growth_mib * 1048576, row['heap']['usedSize'])
                check(result, 'host-listeners-stable', all(app['host'][k] == baseline['app']['host'][k] for k in ['fluxListeners','storeListeners']))
            save(args, name, result)
            print(json.dumps({'checkpoint':label,'seconds':round(row['soakElapsed'],1),'cycles':result['completedCycles'],
                              'phase':current_phase,'mode':mode,'heapMiB':round(row['heap']['usedSize']/1048576,3),
                              'refreshes':app['fixture']['refreshSuccess'],'failedAssertions':sum(not x['pass'] for x in result['assertions'])}), flush=True)
            return row
        sample('soak-start')
        next_sample = args.sample_seconds
        last_block = -1
        while time.monotonic() - soak_start < args.seconds:
            elapsed = time.monotonic() - soak_start
            block = min(blocks - 1, int(elapsed / block_seconds))
            if block != last_block:
                last_block = block
                activity += 1
                current_phase = 'actions'
                page.evaluate('async()=>{harness.ui.set({windowOpen:false,management:false});await testFrame()}')
            if outages and elapsed >= outages[0] and active_outage is None and recovery is None:
                outages.pop(0)
                before = page.evaluate('hostMetrics().openedStreams')
                page.evaluate('fixtureNetwork(false)')
                active_outage = {'started':elapsed, 'openedBefore':before}
                result['events'].append({'type':'network-loss', 'elapsed':elapsed})
                activity += 1
            if active_outage and elapsed >= active_outage['started'] + outage_duration:
                page.evaluate('fixtureNetwork(true)')
                recovery = {**active_outage, 'restored':elapsed}
                active_outage = None
                result['events'].append({'type':'network-restored', 'elapsed':elapsed})
                activity += 1
            if recovery:
                state = page.evaluate('({phase:harness.panel.get().phase,streams:hostMetrics().streams,opened:hostMetrics().openedStreams})')
                if state['phase'] == 'ready' and state['streams'] == 1 and state['opened'] > recovery['openedBefore']:
                    result['events'].append({'type':'network-recovered-ready', 'elapsed':elapsed, 'recoverySeconds':elapsed-recovery['restored']})
                    recovery = None
                    activity += 1
                elif elapsed - recovery['restored'] > (15 if args.smoke else 90):
                    check(result, 'network-recovery-deadline', False, state)
                    raise RuntimeError('Network recovery did not return to ready with a new SSE stream')
            target = math.ceil(args.cycles * (block + 1) / blocks)
            if result['completedCycles'] < target and not active_outage and not recovery:
                current_phase = 'actions'
                activity += 1
                count = min(5, target - result['completedCycles'])
                page.evaluate(CYCLE_JS, count)
                result['completedCycles'] += count
                if result['completedCycles'] % 50 == 0 or result['completedCycles'] == args.cycles:
                    sample('cycles-closed')
                    next_sample = time.monotonic() - soak_start + args.sample_seconds
            else:
                desired = ['closed','picker','settings'][block % 3]
                next_phase = 'network' if active_outage or recovery else 'idle'
                if mode != desired or current_phase == 'actions':
                    page.evaluate('async(mode)=>{harness.ui.set({windowOpen:mode==="picker",management:mode==="settings"});await testFrame()}', desired)
                    mode = desired
                    activity += 1
                    current_phase = next_phase
                    sample('idle-start-' + mode)
                    next_sample = time.monotonic() - soak_start + args.sample_seconds
                current_phase = next_phase
                page.wait_for_timeout(250 if args.smoke else 1000)
            if time.monotonic() - soak_start >= next_sample:
                sample('checkpoint')
                next_sample = time.monotonic() - soak_start + args.sample_seconds
        result['realSoakSeconds'] = time.monotonic() - soak_start
        final_live = sample('soak-end')
        check(result, 'real-duration', result['realSoakSeconds'] >= args.seconds)
        check(result, 'cycle-count', result['completedCycles'] >= args.cycles, result['completedCycles'])
        check(result, 'network-recovered', len([e for e in result['events'] if e['type']=='network-recovered-ready']) == (1 if args.smoke else 2))
        fx = final_live['app']['fixture']
        check(result, 'ready-at-end', final_live['app']['phase'] == 'ready' and final_live['app']['host']['streams'] == 1)
        check(result, 'single-device-login', fx['deviceGrants'] == 1, fx['deviceGrants'])
        if not args.smoke:
            check(result, 'oauth-real-900s-refresh', fx['refreshSuccess'] >= 3 and fx['expiryEvents'] >= 3, fx)
            gaps = [(b['issuedAt']-a['issuedAt'])/1000 for a,b in zip(fx['rotations'], fx['rotations'][1:])]
            check(result, 'no-accelerated-token-clock', len(gaps)>=3 and all(t>=899 for t in gaps), gaps)
            result['coverage']['oauth900s'] = 'passed' if fx['refreshSuccess']>=3 and all(t>=899 for t in gaps) else 'failed'
            for idle in ['closed','picker','settings']:
                seconds = sum(x['seconds'] for x in result['idleIntervals'] if x['mode']==idle)
                check(result, 'passive-idle-' + idle, seconds>=60, seconds)
        run.stop(page)
        page.wait_for_timeout(1000)
        stopped = run.measure(page, cdp, 'stopped', result['completedCycles'])
        result['samples'].append(stopped)
        cleanup_assertions(result, stopped)
        calls = stopped['app']['host']['apiCalls']
        page.wait_for_timeout(2000)
        after = run.measure(page, cdp, 'stopped-quiescent', result['completedCycles'])
        result['samples'].append(after)
        cleanup_assertions(result, after)
        result['cleanupCompleted'] = True
        check(result, 'no-api-after-stop', after['app']['host']['apiCalls'] == calls)
        check(result, 'no-page-errors', not result['errors'], result['errors'])
        check(result, 'no-external-requests', not result['externalRequests'], result['externalRequests'])
        gaps = [b['elapsed']-a['elapsed'] for a,b in zip(result['samples'], result['samples'][1:])]
        check(result, 'checkpoint-gaps-at-most-60s', max(gaps, default=0)<=60, max(gaps, default=0))
except BaseException as e:
    result['failure'] = type(e).__name__ + ': ' + str(e)
    check(result, 'run-completed', False, result['failure'])
finally:
    result['durationSeconds'] = time.monotonic() - started
    result['idleSummary'] = {}
    for idle in ['closed', 'picker', 'settings']:
        intervals = [x for x in result['idleIntervals'] if x['mode'] == idle]
        seconds = sum(x['seconds'] for x in intervals)
        task = sum(x['taskSeconds'] for x in intervals)
        result['idleSummary'][idle] = {'seconds': seconds, 'taskSeconds': task,
            'mainThreadPercent': task / seconds * 100 if seconds else None,
            'maxIntervalPercent': max((x['mainThreadPercent'] for x in intervals), default=None)}
    result['status'] = 'pass' if result['assertions'] and all(x['pass'] for x in result['assertions']) and not result.get('failure') else 'fail'
    save(args, name, result)
    print(json.dumps({'status':result['status'],'output':str(args.out/name),'durationSeconds':result['durationSeconds']}), flush=True)
raise SystemExit(0 if result['status']=='pass' else 1)
