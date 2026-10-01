'use strict';

/**
 * Legacy-style monolith: orders + inventory in one process.
 * Intentionally simple / slightly "enterprise-era" — in-memory, one binary.
 * Not a real POS. Educational strangler-fig lab only.
 */

const http = require('http');
const { randomUUID } = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';

/** @type {Map<string, object>} */
const orders = new Map();
const reservations = new Map();

/** @type {Map<string, { sku: string, name: string, quantity: number }>} */
const inventory = new Map([
  ['SKU-COFFEE-01', { sku: 'SKU-COFFEE-01', name: 'House Blend Beans 1kg', quantity: 100 }],
  ['SKU-MUG-12', { sku: 'SKU-MUG-12', name: 'Ceramic Mug 12oz', quantity: 40 }],
  ['SKU-FILTER-100', { sku: 'SKU-FILTER-100', name: 'Paper Filters (100pk)', quantity: 200 }],
]);

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'X-Served-By': 'legacy-monolith',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];let size=0;let excessive=false;
    req.on('data', (c) => {size+=c.length;if(size>1048576){if(!excessive)reject(Object.assign(new Error('body exceeds limit'),{status:413}));excessive=true;return;}chunks.push(c);});
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function validateOrderCreate(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (!body.customerId || typeof body.customerId !== 'string') return 'customerId (string) required';
  if (!Array.isArray(body.items) || body.items.length === 0) return 'items (non-empty array) required';
  for (const item of body.items) {
    if (!item || typeof item.sku !== 'string' || !item.sku) return 'each item needs sku';
    if (!Number.isInteger(item.quantity) || item.quantity < 1) return 'each item needs quantity >= 1';
  }
  return null;
}

function createOrder(body, requestId = body.requestId || randomUUID()) {
  if (typeof requestId !== 'string' || !requestId || requestId.length>200) throw Object.assign(new Error('invalid idempotency key'),{status:400});
  for (const order of orders.values()) if (order.requestId===requestId) {
    if (order.customerId!==body.customerId || JSON.stringify(order.items)!==JSON.stringify(body.items.map(item=>({sku:item.sku,quantity:item.quantity})))) throw Object.assign(new Error('idempotency key reused with different order'),{status:409});
    return order;
  }
  reserveBatch(body.items,requestId);

  const id = randomUUID();
  const order = {
    id,
    requestId,
    customerId: body.customerId,
    items: body.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
    status: 'confirmed',
    createdAt: new Date().toISOString(),
  };
  orders.set(id, order);
  return order;
}

function getOrder(id) {
  return orders.get(id) || null;
}

function getInventory(sku) {
  return inventory.get(sku) || null;
}

function reserveInventory(sku, quantity) {
  if (!Number.isInteger(quantity) || quantity < 1) {
    const err = new Error('quantity (integer >= 1) required');
    err.status = 400;
    throw err;
  }
  const stock = inventory.get(sku);
  if (!stock) {
    const err = new Error(`unknown sku: ${sku}`);
    err.status = 404;
    throw err;
  }
  if (stock.quantity < quantity) {
    const err = new Error(
      `insufficient stock for ${sku}: have ${stock.quantity}, need ${quantity}`,
    );
    err.status = 409;
    throw err;
  }
  stock.quantity -= quantity;
  return {
    sku: stock.sku,
    reserved: quantity,
    remaining: stock.quantity,
  };
}

function reserveBatch(items, requestId) {
  if (!Array.isArray(items) || !items.length) throw Object.assign(new Error('items (non-empty array) required'), {status:400});
  const signature=JSON.stringify(items.map(item=>({sku:item?.sku,quantity:item?.quantity})));
  if (requestId!==undefined) {
    if (typeof requestId!=='string' || !requestId || requestId.length>200) throw Object.assign(new Error('invalid idempotency key'),{status:400});
    if (reservations.has(requestId)) {
      if (reservations.get(requestId)!==signature) throw Object.assign(new Error('idempotency key reused with different reservation'),{status:409});
      return {reserved:true};
    }
  }
  const totals = new Map();
  for (const item of items) {
    if (!item || typeof item.sku !== 'string' || !item.sku || !Number.isSafeInteger(item.quantity) || item.quantity < 1) throw Object.assign(new Error('invalid reservation item'), {status:400});
    const total = (totals.get(item.sku) || 0) + item.quantity;
    if (!Number.isSafeInteger(total)) throw Object.assign(new Error('quantity overflow'), {status:400});
    totals.set(item.sku,total);
  }
  for (const [sku,quantity] of totals) {
    const stock=inventory.get(sku);
    if (!stock) throw Object.assign(new Error(`unknown sku: ${sku}`), {status:404});
    if (stock.quantity < quantity) throw Object.assign(new Error(`insufficient stock for ${sku}: have ${stock.quantity}, need ${quantity}`), {status:409});
  }
  // No await between validation and mutation: the whole batch is atomic in this process.
  for (const [sku,quantity] of totals) inventory.get(sku).quantity-=quantity;
  if(requestId!==undefined) reservations.set(requestId,signature);
  return {reserved:true};
}

function adminAllowed(req) {
  const token=process.env.LAB_ADMIN_TOKEN;
  return token && req.headers.authorization === `Bearer ${token}`;
}

async function handler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = (req.method || 'GET').toUpperCase();

  try {
    if (path.startsWith('/__state/')) {
      if (!adminAllowed(req)) return send(res,403,{error:'admin authorization required'});
      const target=path==='/__state/orders'?orders:path==='/__state/inventory'?inventory:null;
      if (!target) return send(res,404,{error:'not found'});
      if (method==='GET') return send(res,200,target===inventory?{stock:Array.from(inventory.values()),reservations:Object.fromEntries(reservations)}:Array.from(orders.values()));
      if (method==='PUT') {
        const body=await readBody(req);
        const rows=target===inventory?body?.stock:body;
        const receipts=target===inventory?body?.reservations:null;
        if(target===inventory && (!receipts || typeof receipts!=="object" || Array.isArray(receipts) || Object.entries(receipts).some(([key,value])=>!key || key.length>200 || typeof value!=="string" || value.length>16384)))return send(res,400,{error:"invalid reservation state"});
        if (!Array.isArray(rows)) return send(res,400,{error:'state must be an array'});
        const replacement=new Map();
        for (const row of rows) {
          const key=target===orders?row?.id:row?.sku;
          const valid=target===orders ? typeof key==='string' && key && !validateOrderCreate(row) && row.status==='confirmed' && Number.isFinite(Date.parse(row.createdAt)) : typeof key==='string' && key && typeof row.name==='string' && Number.isSafeInteger(row.quantity) && row.quantity>=0;
          if (!valid || replacement.has(key)) return send(res,400,{error:'invalid state row'});
          replacement.set(key,row);
        }
        target.clear();for(const [key,row] of replacement) target.set(key,row);
        if(target===inventory){reservations.clear();for(const [key,value]of Object.entries(receipts))reservations.set(key,value);}
        return send(res,200,{imported:rows.length});
      }
      return send(res,405,{error:'method not allowed'});
    }
    if (method==='POST' && path==='/inventory/reservations') {
      const body=await readBody(req);return send(res,200,reserveBatch(body.items,req.headers["idempotency-key"]));
    }

    if (method === 'GET' && path === '/health') {
      return send(res, 200, { status: 'ok', service: 'legacy-monolith', runId:process.env.LAB_RUN_ID||null });
    }

    if (method === 'POST' && path === '/orders') {
      const body = await readBody(req);
      const verr = validateOrderCreate(body);
      if (verr) return send(res, 400, { error: verr });
      const order = createOrder(body,req.headers["idempotency-key"] || body.requestId || randomUUID());
      return send(res, 201, order);
    }

    const orderMatch = path.match(/^\/orders\/([^/]+)$/);
    if (method === 'GET' && orderMatch) {
      const order = getOrder(orderMatch[1]);
      if (!order) return send(res, 404, { error: 'order not found' });
      return send(res, 200, order);
    }

    const invMatch = path.match(/^\/inventory\/([^/]+)$/);
    if (method === 'GET' && invMatch) {
      const item = getInventory(decodeURIComponent(invMatch[1]));
      if (!item) return send(res, 404, { error: 'sku not found' });
      return send(res, 200, item);
    }

    const reserveMatch = path.match(/^\/inventory\/([^/]+)\/reserve$/);
    if (method === 'POST' && reserveMatch) {
      const body = await readBody(req);
      const result = reserveInventory(decodeURIComponent(reserveMatch[1]), body.quantity);
      return send(res, 200, result);
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    const status = err.status || 500;
    return send(res, status, { error: err.message || 'internal error' });
  }
}

const server = http.createServer(handler);

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`legacy-monolith listening on http://${HOST}:${PORT}`);
  });
}

module.exports = {
  server,
  createOrder,
  getOrder,
  getInventory,
  reserveInventory,
  validateOrderCreate,
  orders,
  inventory,
};
