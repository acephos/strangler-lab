'use strict';

/**
 * Agentic Shadow Traffic & Divergence Auditor
 *
 * Simulates production traffic mirroring across the gateway, collects
 * real-time response diffs and latency comparisons, and produces a divergence scorecard.
 */

const http = require('node:http');
const { setTimeout: sleep } = require('node:timers/promises');

function request(url, method, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const start = performance.now();
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {},
        timeout: 5000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const duration = performance.now() - start;
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = { _raw: raw };
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: json,
            durationMs: duration,
          });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

async function runShadowAudit(gatewayUrl = 'http://127.0.0.1:8000', options = {}) {
  const count = options.samples || 5;

  // 1. Reset shadow metrics
  await request(`${gatewayUrl}/__shadow/reset`, 'POST');

  // 2. Enable shadow mirroring on orders
  await request(`${gatewayUrl}/__admin/cutover`, 'POST', {
    ordersNew: true,
    shadowOrders: true,
  });

  const latencies = [];

  // 3. Dispatch sample workload
  for (let i = 0; i < count; i++) {
    const res = await request(`${gatewayUrl}/orders`, 'POST', {
      customerId: `shadow-audit-user-${i}`,
      items: [{ sku: 'SKU-COFFEE-01', quantity: 1 }],
    });
    latencies.push(res.durationMs);
  }

  await sleep(150); // wait for background shadow comparison

  // 4. Fetch shadow stats
  const statsRes = await request(`${gatewayUrl}/__shadow/stats`, 'GET');
  const stats = statsRes.body || {};

  const avgLatency =
    latencies.length > 0
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : 0;

  return {
    timestamp: new Date().toISOString(),
    totalSamplesDispatched: count,
    shadowRequestsEvaluated: stats.shadowRequests || 0,
    shadowMatches: stats.shadowMatches || 0,
    divergenceCount: stats.diffCount || 0,
    divergenceRate: stats.divergenceRate || 0.0,
    averageLatencyMs: Number(avgLatency.toFixed(2)),
    status: (stats.diffCount || 0) === 0 ? 'PASSED_ZERO_DIVERGENCE' : 'DIVERGENCE_DETECTED',
  };
}

if (require.main === module) {
  runShadowAudit().then((r) => console.log(JSON.stringify(r, null, 2)));
}

module.exports = { runShadowAudit };
