'use strict';

/**
 * Contract tests: prove legacy monolith and Go microservices satisfy
 * the exact same OpenAPI request/response shapes for both Orders and Inventory.
 *
 * Run via `npm test` in this directory (starts servers itself) or through
 * `make contract`.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

const ROOT = path.resolve(__dirname, '..');
const LEGACY_PORT = Number(process.env.CONTRACT_LEGACY_PORT || 18080);
const ORDERS_PORT = Number(process.env.CONTRACT_ORDERS_PORT || 18081);
const INVENTORY_PORT = Number(process.env.CONTRACT_INVENTORY_PORT || 18082);
const EXTERNAL = process.env.CONTRACT_EXTERNAL === '1';

const children = [];

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // ignore
  }
}

async function killAll(list) {
  for (const c of list) killTree(c);
  await sleep(200);
}

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
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
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = { _raw: raw };
          }
          resolve({ status: res.statusCode, headers: res.headers, body: json });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    if (data) req.write(data);
    req.end();
  });
}

async function waitHealthy(port, serviceHint, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await request(port, 'GET', '/health');
      if (res.status === 200) return res;
    } catch {
      // retry
    }
    await sleep(150);
  }
  throw new Error(`service on :${port} (${serviceHint}) did not become healthy`);
}

function spawnProc(cmd, args, env, cwd) {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  child.on('error', (err) => {
    console.error('spawn error', cmd, err.message);
  });
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

function assertOrderShape(order, expectedCustomer, expectedItems) {
  assert.equal(typeof order.id, 'string');
  assert.ok(order.id.length > 0, 'id non-empty');
  assert.equal(order.customerId, expectedCustomer);
  assert.equal(order.status, 'confirmed');
  assert.equal(typeof order.createdAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(order.createdAt)), 'createdAt is date-time');
  assert.ok(Array.isArray(order.items));
  assert.equal(order.items.length, expectedItems.length);
  for (let i = 0; i < expectedItems.length; i++) {
    assert.equal(order.items[i].sku, expectedItems[i].sku);
    assert.equal(order.items[i].quantity, expectedItems[i].quantity);
  }
}

function assertStockShape(stock, expectedSku) {
  assert.equal(typeof stock.sku, 'string');
  assert.equal(stock.sku, expectedSku);
  assert.equal(typeof stock.name, 'string');
  assert.equal(typeof stock.quantity, 'number');
  assert.ok(stock.quantity >= 0);
}

function assertReserveShape(resBody, expectedSku, expectedReserved) {
  assert.equal(typeof resBody.sku, 'string');
  assert.equal(resBody.sku, expectedSku);
  assert.equal(typeof resBody.reserved, 'number');
  assert.equal(resBody.reserved, expectedReserved);
  assert.equal(typeof resBody.remaining, 'number');
  assert.ok(resBody.remaining >= 0);
}

function assertErrorShape(body) {
  assert.equal(typeof body.error, 'string');
  assert.ok(body.error.length > 0);
}

describe('strangler-lab contract tests (legacy vs Go services)', () => {
  before(async () => {
    if (EXTERNAL) {
      await waitHealthy(LEGACY_PORT, 'legacy-external');
      await waitHealthy(ORDERS_PORT, 'orders-external');
      await waitHealthy(INVENTORY_PORT, 'inventory-external');
      return;
    }

    // 1. Legacy monolith (orders + inventory)
    spawnProc(
      process.execPath,
      [path.join(ROOT, 'legacy', 'server.js')],
      { PORT: String(LEGACY_PORT), HOST: '127.0.0.1' },
      path.join(ROOT, 'legacy'),
    );

    // 2. orders-go (slice 1)
    const ordersDir = path.join(ROOT, 'services', 'orders-go');
    const ordersBin = process.platform === 'win32' ? 'orders-go-bin.exe' : 'orders-go-bin';
    await buildGo(ordersDir, ordersBin);
    spawnProc(
      path.join(ordersDir, ordersBin),
      [],
      {
        PORT: String(ORDERS_PORT),
        INVENTORY_URL: `http://127.0.0.1:${LEGACY_PORT}`,
      },
      ordersDir,
    );

    // 3. inventory-go (slice 2)
    const invDir = path.join(ROOT, 'services', 'inventory-go');
    const invBin = process.platform === 'win32' ? 'inventory-go-bin.exe' : 'inventory-go-bin';
    await buildGo(invDir, invBin);
    spawnProc(
      path.join(invDir, invBin),
      [],
      {
        PORT: String(INVENTORY_PORT),
      },
      invDir,
    );

    await waitHealthy(LEGACY_PORT, 'legacy');
    await waitHealthy(ORDERS_PORT, 'orders-go');
    await waitHealthy(INVENTORY_PORT, 'inventory-go');
  });

  after(async () => {
    await killAll(children);
  });

  describe('orders domain contract (legacy vs orders-go)', () => {
    const cases = [
      { name: 'legacy', port: () => LEGACY_PORT },
      { name: 'orders-go', port: () => ORDERS_PORT },
    ];

    for (const c of cases) {
      describe(c.name, () => {
        it('POST /orders happy path returns 201 + Order shape', async () => {
          const items = [{ sku: 'SKU-FILTER-100', quantity: 1 }];
          const res = await request(c.port(), 'POST', '/orders', {
            customerId: `cust-${c.name}`,
            items,
          });
          assert.equal(res.status, 201, JSON.stringify(res.body));
          assertOrderShape(res.body, `cust-${c.name}`, items);
        });

        it('GET /orders/:id returns same shape', async () => {
          const items = [{ sku: 'SKU-MUG-12', quantity: 1 }];
          const created = await request(c.port(), 'POST', '/orders', {
            customerId: `cust-get-${c.name}`,
            items,
          });
          assert.equal(created.status, 201, JSON.stringify(created.body));
          const res = await request(c.port(), 'GET', `/orders/${created.body.id}`);
          assert.equal(res.status, 200);
          assertOrderShape(res.body, `cust-get-${c.name}`, items);
          assert.equal(res.body.id, created.body.id);
        });

        it('POST /orders missing customerId → 400 + error shape', async () => {
          const res = await request(c.port(), 'POST', '/orders', {
            items: [{ sku: 'SKU-COFFEE-01', quantity: 1 }],
          });
          assert.equal(res.status, 400);
          assertErrorShape(res.body);
        });

        it('POST /orders empty items → 400 + error shape', async () => {
          const res = await request(c.port(), 'POST', '/orders', {
            customerId: 'x',
            items: [],
          });
          assert.equal(res.status, 400);
          assertErrorShape(res.body);
        });

        it('GET /orders/missing → 404 + error shape', async () => {
          const res = await request(c.port(), 'GET', '/orders/00000000-0000-0000-0000-000000000000');
          assert.equal(res.status, 404);
          assertErrorShape(res.body);
        });

        it('POST /orders unknown sku → 404 + error shape', async () => {
          const res = await request(c.port(), 'POST', '/orders', {
            customerId: 'x',
            items: [{ sku: 'SKU-NOPE', quantity: 1 }],
          });
          assert.equal(res.status, 404);
          assertErrorShape(res.body);
        });
      });
    }
  });

  describe('inventory domain contract (legacy vs inventory-go)', () => {
    const cases = [
      { name: 'legacy', port: () => LEGACY_PORT },
      { name: 'inventory-go', port: () => INVENTORY_PORT },
    ];

    for (const c of cases) {
      describe(c.name, () => {
        it('GET /inventory/:sku returns 200 + Stock shape', async () => {
          const res = await request(c.port(), 'GET', '/inventory/SKU-COFFEE-01');
          assert.equal(res.status, 200);
          assertStockShape(res.body, 'SKU-COFFEE-01');
        });

        it('GET /inventory/missing → 404 + error shape', async () => {
          const res = await request(c.port(), 'GET', '/inventory/SKU-DOES-NOT-EXIST');
          assert.equal(res.status, 404);
          assertErrorShape(res.body);
        });

        it('POST /inventory/:sku/reserve valid quantity → 200 + ReserveResponse', async () => {
          const res = await request(c.port(), 'POST', '/inventory/SKU-COFFEE-01/reserve', {
            quantity: 2,
          });
          assert.equal(res.status, 200);
          assertReserveShape(res.body, 'SKU-COFFEE-01', 2);
        });

        it('POST /inventory/:sku/reserve invalid quantity (<=0) → 400 + error shape', async () => {
          const res = await request(c.port(), 'POST', '/inventory/SKU-COFFEE-01/reserve', {
            quantity: 0,
          });
          assert.equal(res.status, 400);
          assertErrorShape(res.body);
        });

        it('POST /inventory/:sku/reserve unknown sku → 404 + error shape', async () => {
          const res = await request(c.port(), 'POST', '/inventory/SKU-DOES-NOT-EXIST/reserve', {
            quantity: 1,
          });
          assert.equal(res.status, 404);
          assertErrorShape(res.body);
        });

        it('POST /inventory/:sku/reserve insufficient stock → 409 + error shape', async () => {
          const res = await request(c.port(), 'POST', '/inventory/SKU-COFFEE-01/reserve', {
            quantity: 999999,
          });
          assert.equal(res.status, 409);
          assertErrorShape(res.body);
        });
      });
    }
  });
});
