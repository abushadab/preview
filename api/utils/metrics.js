const GUARDRAIL_STATUSES = new Map();
const READY_STATUSES = new Map();
const READY_LATENCY_BUCKETS = [50, 100, 250, 500, 1000, 2000, 5000];
const READY_LATENCY_COUNTS = new Array(READY_LATENCY_BUCKETS.length).fill(0);
let readyLatencySum = 0;
let readyLatencyCount = 0;

function incrementCounter(store, key) {
  const current = store.get(key) || 0;
  store.set(key, current + 1);
}

function observeLatency(ms) {
  readyLatencyCount += 1;
  readyLatencySum += ms;

  for (let i = 0; i < READY_LATENCY_BUCKETS.length; i += 1) {
    if (ms <= READY_LATENCY_BUCKETS[i]) {
      READY_LATENCY_COUNTS[i] += 1;
    }
  }
}

function requestObserver(req, res, next) {
  const started = process.hrtime.bigint();

  res.on('finish', () => {
    if ([401, 403, 413, 415].includes(res.statusCode)) {
      incrementCounter(GUARDRAIL_STATUSES, String(res.statusCode));
    }

    if (req.path.startsWith('/sandbox/') && req.path.endsWith('/ready')) {
      incrementCounter(READY_STATUSES, String(res.statusCode));
      const elapsed = Number((process.hrtime.bigint() - started) / BigInt(1e6));
      observeLatency(elapsed);
    }
  });

  next();
}

async function sendMetrics(req, res) {
  const lines = [];
  lines.push('# HELP sandbox_api_guardrail_total Counts guarded responses');
  lines.push('# TYPE sandbox_api_guardrail_total counter');
  for (const [status, count] of GUARDRAIL_STATUSES.entries()) {
    lines.push(`sandbox_api_guardrail_total{status="${status}"} ${count}`);
  }

  lines.push('# HELP sandbox_ready_status_total Counts /sandbox/:id/ready outcomes');
  lines.push('# TYPE sandbox_ready_status_total counter');
  for (const [status, count] of READY_STATUSES.entries()) {
    lines.push(`sandbox_ready_status_total{status="${status}"} ${count}`);
  }

  lines.push('# HELP sandbox_ready_latency_ms Latency for sandbox readiness probes');
  lines.push('# TYPE sandbox_ready_latency_ms histogram');

  for (let i = 0; i < READY_LATENCY_BUCKETS.length; i += 1) {
    const le = READY_LATENCY_BUCKETS[i];
    lines.push(`sandbox_ready_latency_ms_bucket{le="${le}"} ${READY_LATENCY_COUNTS[i]}`);
  }
  lines.push(`sandbox_ready_latency_ms_bucket{le="+Inf"} ${readyLatencyCount}`);
  lines.push(`sandbox_ready_latency_ms_sum ${readyLatencySum}`);
  lines.push(`sandbox_ready_latency_ms_count ${readyLatencyCount}`);

  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send(lines.join('\n'));
}

module.exports = { requestObserver, sendMetrics };
