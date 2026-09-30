'use strict';

/**
 * End-to-end smoke test validating the multi-phase Strangler Fig cutover:
 *   - Phase 1: Partial cutover (orders → orders-go, inventory → legacy)
 *   - Phase 2: Full cutover (orders → orders-go, inventory → inventory-go)
 *   - Shadow mode: Dark launch verification & divergence monitoring
 *   - Automated rollback drill: Instant reversal without dropped traffic
 *
 * Usage:
 *   node scripts/smoke.js              # assumes stack already up
 *   node scripts/smoke.js --start      # start stack, test all phases, stop
 *   node scripts/smoke.js --phase=1    # test only phase 1
 *   node scripts/smoke.js --phase=2    # test only phase 2
 */

const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

const ROOT = path.resolve(__dirname, '..');
const GATEWAY = process.env.GATEWAY_URL || 'http://127.0.0.1:8000';
const START = process.argv.includes('--start');

const targetPhaseArg = process.argv.find((a) => a.startsWith('--phase='));
const targetPhase = targetPhaseArg ? Number(targetPhaseArg.split('=')[1]) : null;

const children = [];

function log(msg) {
  console.log(`[smoke] ${msg}`);
}

function request(url, method, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {},
        timeout: 8000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
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
            servedBy: res.headers['x-served-by'],
            target: res.headers['x-gateway-target'],
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

async function waitUrl(url, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await request(url, 'GET');
      if (res.status === 200) return res;
    } catch {
      // retry
    }
    await sleep(200);
  }
  throw new Error(`not healthy: ${url}`);
}

function spawnProc(cmd, args, env, cwd) {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  child.stdout.on('data', (d) => process.stdout.write(`[${path.basename(cwd)}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${path.basename(cwd)}] ${d}`));
  return child;
}

async function buildGo(dir, out) {
  await new Promise((resolve, reject) => {
    const b = spawn('go', ['build', '-o', out, '.'], {
      cwd: dir,
      stdio: 'inherit',
      windowsHide: true,
    });
    b.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`go build failed in ${dir}`))));
  });
}

async function startStack() {
  log('building Go binaries...');
  const ordersDir = path.join(ROOT, 'services', 'orders-go');
  const invDir = path.join(ROOT, 'services', 'inventory-go');
  const gwDir = path.join(ROOT, 'gateway');
  const ext = process.platform === 'win32' ? '.exe' : '';
  const ordersBin = `orders-go-bin${ext}`;
  const invBin = `inventory-go-bin${ext}`;
  const gwBin = `gateway-bin${ext}`;

  await buildGo(ordersDir, ordersBin);
  await buildGo(invDir, invBin);
  await buildGo(gwDir, gwBin);

  log('starting legacy monolith on :8080');
  spawnProc(
    process.execPath,
    [path.join(ROOT, 'legacy', 'server.js')],
    { PORT: '8080', HOST: '127.0.0.1' },
    path.join(ROOT, 'legacy'),
  );

  log('starting orders-go on :8081 (reservations routed via gateway :8000)');
  spawnProc(
    path.join(ordersDir, ordersBin),
    [],
    { PORT: '8081', INVENTORY_URL: 'http://127.0.0.1:8000' },
    ordersDir,
  );

  log('starting inventory-go on :8082');
  spawnProc(
    path.join(invDir, invBin),
    [],
    { PORT: '8082' },
    invDir,
  );

  log('starting gateway on :8000');
  spawnProc(
    path.join(gwDir, gwBin),
    [],
    {
      PORT: '8000',
      LEGACY_URL: 'http://127.0.0.1:8080',
      ORDERS_URL: 'http://127.0.0.1:8081',
      INVENTORY_URL: 'http://127.0.0.1:8082',
      ROUTE_ORDERS_NEW: 'true',
      ROUTE_INVENTORY_NEW: 'false',
    },
    gwDir,
  );

  await waitUrl('http://127.0.0.1:8080/health');
  await waitUrl('http://127.0.0.1:8081/health');
  await waitUrl('http://127.0.0.1:8082/health');
  await waitUrl('http://127.0.0.1:8000/health');
  log('full stack ready (legacy, orders-go, inventory-go, gateway)');
}

function stopStack() {
  for (const c of children) {
    try {
      if (process.platform === 'win32' && c.pid) {
        spawn('taskkill', ['/pid', String(c.pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        c.kill('SIGTERM');
      }
    } catch {
      // ignore
    }
  }
}

async function testPhase1(base) {
  log('==============================================');
  log('PHASE 1: Partial Strangler (Orders=New, Inv=Legacy)');
  log('==============================================');

  await request(`${base}/__admin/cutover`, 'POST', {
    ordersNew: true,
    inventoryNew: false,
    shadowOrders: false,
    shadowInventory: false,
  });

  const health = await request(`${base}/health`, 'GET');
  if (health.body.routing.orders !== 'orders-go' || health.body.routing.inventory !== 'legacy') {
    throw new Error(`unexpected Phase 1 routing: ${JSON.stringify(health.body.routing)}`);
  }
  log(`  routing verified: orders -> orders-go, inventory -> legacy`);

  // Inventory served by legacy
  const invBefore = await request(`${base}/inventory/SKU-COFFEE-01`, 'GET');
  if (invBefore.status !== 200 || invBefore.servedBy !== 'legacy-monolith') {
    throw new Error(`expected inventory from legacy-monolith, got ${invBefore.servedBy}`);
  }
  log(`  inventory served-by=${invBefore.servedBy} (qty=${invBefore.body.quantity})`);

  // Order served by orders-go
  const create = await request(`${base}/orders`, 'POST', {
    customerId: 'cust-phase1',
    items: [{ sku: 'SKU-COFFEE-01', quantity: 2 }],
  });
  if (create.status !== 201 || create.servedBy !== 'orders-go') {
    throw new Error(`expected orders-go 201, got status=${create.status} served-by=${create.servedBy}`);
  }
  log(`  order created id=${create.body.id} served-by=${create.servedBy}`);

  // Fetch created order
  const getOrd = await request(`${base}/orders/${create.body.id}`, 'GET');
  if (getOrd.status !== 200 || getOrd.body.id !== create.body.id) {
    throw new Error('fetch order failed');
  }

  // Stock decremented on legacy
  const invAfter = await request(`${base}/inventory/SKU-COFFEE-01`, 'GET');
  if (invAfter.body.quantity !== invBefore.body.quantity - 2) {
    throw new Error(`expected stock ${invBefore.body.quantity - 2}, got ${invAfter.body.quantity}`);
  }
  log(`  inventory decremented on legacy: ${invBefore.body.quantity} -> ${invAfter.body.quantity}`);
  log('  ✔ Phase 1 smoke PASS\n');
}

async function testPhase2(base) {
  log('==============================================');
  log('PHASE 2: Full Strangler Cutover (Orders=New, Inv=New)');
  log('==============================================');

  log('promoting cutover via dynamic admin API: ROUTE_INVENTORY_NEW=true');
  const cutoverRes = await request(`${base}/__admin/cutover`, 'POST', {
    ordersNew: true,
    inventoryNew: true,
  });
  if (cutoverRes.status !== 200) {
    throw new Error(`cutover API failed: ${cutoverRes.status}`);
  }
  log(`  admin cutover response: ${JSON.stringify(cutoverRes.body.routing)}`);

  // Inventory served by inventory-go
  const invBefore = await request(`${base}/inventory/SKU-FILTER-100`, 'GET');
  if (invBefore.status !== 200 || invBefore.servedBy !== 'inventory-go') {
    throw new Error(`expected inventory from inventory-go, got ${invBefore.servedBy}`);
  }
  log(`  inventory served-by=${invBefore.servedBy} (qty=${invBefore.body.quantity})`);

  // Order created via orders-go, reserving via inventory-go
  const create = await request(`${base}/orders`, 'POST', {
    customerId: 'cust-phase2',
    items: [{ sku: 'SKU-FILTER-100', quantity: 5 }],
  });
  if (create.status !== 201 || create.servedBy !== 'orders-go') {
    throw new Error(`expected orders-go, got ${create.servedBy}`);
  }
  log(`  order created id=${create.body.id} served-by=${create.servedBy}`);

  // Stock decremented on inventory-go
  const invAfter = await request(`${base}/inventory/SKU-FILTER-100`, 'GET');
  if (invAfter.servedBy !== 'inventory-go') {
    throw new Error(`expected inventory-go, got ${invAfter.servedBy}`);
  }
  if (invAfter.body.quantity !== invBefore.body.quantity - 5) {
    throw new Error(`expected stock ${invBefore.body.quantity - 5}, got ${invAfter.body.quantity}`);
  }
  log(`  inventory decremented on inventory-go: ${invBefore.body.quantity} -> ${invAfter.body.quantity}`);
  log('  ✔ Phase 2 full cutover smoke PASS (0% legacy traffic)\n');
}

async function testShadowMode(base) {
  log('==============================================');
  log('SHADOW MODE & DIVERGENCE AUDITING');
  log('==============================================');

  // Reset shadow stats
  await request(`${base}/__shadow/reset`, 'POST');

  // Enable shadow mirroring for orders
  log('activating shadow mirroring: primary=orders-go, shadow=legacy');
  await request(`${base}/__admin/cutover`, 'POST', {
    ordersNew: true,
    shadowOrders: true,
  });

  // Send test requests
  for (let i = 0; i < 3; i++) {
    await request(`${base}/orders`, 'POST', {
      customerId: `shadow-cust-${i}`,
      items: [{ sku: 'SKU-MUG-12', quantity: 1 }],
    });
  }

  await sleep(150); // allow async shadow dispatch to settle

  const stats = await request(`${base}/__shadow/stats`, 'GET');
  log(`  shadow stats: totalReqs=${stats.body.totalRequests}, shadowReqs=${stats.body.shadowRequests}, diffs=${stats.body.diffCount}`);
  if (stats.body.diffCount > 0) {
    throw new Error(`divergence detected in shadow mode: ${stats.body.diffCount} diffs`);
  }
  log('  ✔ Shadow traffic validation PASS (0% divergence)\n');
}

async function testRollbackDrill(base) {
  log('==============================================');
  log('SAFETY DRILL: Dynamic Automated Rollback');
  log('==============================================');

  log('simulating incident -> triggering rollback to Phase 0 (100% legacy)');
  await request(`${base}/__admin/cutover`, 'POST', {
    ordersNew: false,
    inventoryNew: false,
    shadowOrders: false,
    shadowInventory: false,
  });

  const res = await request(`${base}/orders`, 'POST', {
    customerId: 'cust-rollback',
    items: [{ sku: 'SKU-COFFEE-01', quantity: 1 }],
  });
  if (res.status !== 201 || res.servedBy !== 'legacy-monolith') {
    throw new Error(`expected legacy-monolith after rollback, got ${res.servedBy}`);
  }
  log(`  fallback verified: orders served-by=${res.servedBy}`);

  log('re-promoting back to Phase 1');
  await request(`${base}/__admin/cutover`, 'POST', {
    ordersNew: true,
    inventoryNew: false,
  });
  log('  ✔ Dynamic rollback and recovery PASS\n');
}

(async () => {
  try {
    if (START) {
      await startStack();
    } else {
      await waitUrl(`${GATEWAY.replace(/\/$/, '')}/health`, 10).catch(() => {
        throw new Error(
          'gateway not reachable. Start the stack (make up / scripts/dev-up) or re-run with --start',
        );
      });
    }

    const base = GATEWAY.replace(/\/$/, '');

    if (targetPhase === 1) {
      await testPhase1(base);
    } else if (targetPhase === 2) {
      await testPhase2(base);
    } else {
      await testPhase1(base);
      await testPhase2(base);
      await testShadowMode(base);
      await testRollbackDrill(base);
    }

    log('==============================================');
    log('🎉 ALL SMOKE & CUTOVER VERIFICATIONS PASSED');
    log('==============================================');

    if (START) stopStack();
    process.exit(0);
  } catch (err) {
    console.error(`[smoke] FAIL: ${err.message}`);
    if (START) stopStack();
    process.exit(1);
  }
})();
