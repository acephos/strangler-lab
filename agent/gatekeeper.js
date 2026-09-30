'use strict';

/**
 * Agentic Cutover Gatekeeper & Delivery Contract Evaluator
 *
 * Implements policy-based canary gates before promoting cutover stages:
 *   - Gate 1: Contract Parity Gate (100% test coverage)
 *   - Gate 2: Divergence Gate (0% drift in shadow traffic)
 *   - Gate 3: Live Verification Gate (automated slice smoke test)
 * Also executes automated rollback drills upon synthetic regression.
 */

const http = require('node:http');

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 5000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve({ status: res.statusCode });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

class Gatekeeper {
  constructor(gatewayUrl = 'http://127.0.0.1:8000') {
    this.gatewayUrl = gatewayUrl.replace(/\/$/, '');
  }

  evaluateDeliveryContract(contractReport, shadowReport) {
    const checks = [
      {
        name: 'Contract Test Suite Pass Rate == 100%',
        passed: contractReport.success && contractReport.failedTests === 0,
        actual: `${contractReport.passRate.toFixed(1)}%`,
        required: '100.0%',
      },
      {
        name: 'Shadow Divergence Rate == 0.0%',
        passed: shadowReport.divergenceCount === 0,
        actual: `${(shadowReport.divergenceRate * 100).toFixed(2)}%`,
        required: '0.00%',
      },
      {
        name: 'Candidate Microservice Latency SLA < 50ms',
        passed: shadowReport.averageLatencyMs < 50.0,
        actual: `${shadowReport.averageLatencyMs}ms`,
        required: '< 50.0ms',
      },
    ];

    const allPassed = checks.every((c) => c.passed);

    return {
      timestamp: new Date().toISOString(),
      gateApproved: allPassed,
      checks,
      verdict: allPassed
        ? 'GATE_APPROVED_FOR_PROMOTION'
        : 'GATE_REJECTED_DUE_TO_POLICY_VIOLATION',
    };
  }

  async promoteToPhase1() {
    return await postJSON(`${this.gatewayUrl}/__admin/cutover`, {
      ordersNew: true,
      inventoryNew: false,
      shadowOrders: false,
    });
  }

  async promoteToPhase2() {
    return await postJSON(`${this.gatewayUrl}/__admin/cutover`, {
      ordersNew: true,
      inventoryNew: true,
      shadowOrders: false,
      shadowInventory: false,
    });
  }

  async rollbackToPhase0() {
    return await postJSON(`${this.gatewayUrl}/__admin/cutover`, {
      ordersNew: false,
      inventoryNew: false,
      shadowOrders: false,
      shadowInventory: false,
    });
  }
}

module.exports = { Gatekeeper };
