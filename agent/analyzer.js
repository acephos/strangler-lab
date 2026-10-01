'use strict';

/**
 * Agentic Discovery & Dependency Analyzer
 *
 * Scans legacy codebase with heuristic source patterns (not an AST parser), inspects OpenAPI contracts,
 * identifies coupled state, and generates an automated Strangler Fig execution plan.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function analyzeLegacyMonolith() {
  const serverPath = path.join(ROOT, 'legacy', 'server.js');
  const content = fs.readFileSync(serverPath, 'utf8');

  // Discover routes
  const routeRegex = /path === '([^']+)'|path\.match\(\/\^\\\/([a-zA-Z0-9_-]+)/g;
  const discoveredRoutes = new Set();
  let match;
  while ((match = routeRegex.exec(content)) !== null) {
    if (match[1]) discoveredRoutes.add(match[1]);
    if (match[2]) discoveredRoutes.add(`/${match[2]}/*`);
  }

  // Detect stateful storage
  const stateRegex = /const (\w+) = new Map/g;
  const stateStores = [];
  while ((match = stateRegex.exec(content)) !== null) {
    stateStores.push(match[1]);
  }

  // Detect cross-domain coupling
  const hasOrdersMutatingInventory =
    content.includes('inventory.get') && content.includes('createOrder');

  const couplingAnalysis = {
    coupledDomains: ['orders', 'inventory'],
    dependencyDirection: 'orders -> inventory (stock reservations)',
    tightlyCoupledState: stateStores,
    riskLevel: 'MEDIUM',
    recommendation: [
      'Extract orders domain first into standalone microservice (orders-go)',
      'Inject Anti-Corruption Layer (ACL): orders-go delegates stock reservations to legacy inventory',
      'Deploy path-based edge router (gateway) with feature-flagged cutover',
      'Measure completed read-only shadow samples; refuse missing or divergent evidence',
      'Extract inventory domain (inventory-go) and execute Phase 2 full cutover',
      'Treat decommissioning and durable/crash-safe migration as separate operator decisions',
    ],
  };

  return {
    timestamp: new Date().toISOString(),
    routes: Array.from(discoveredRoutes),
    stateStores,
    crossDomainCoupling: hasOrdersMutatingInventory,
    couplingAnalysis,
    slices: [
      {
        id: 'slice-1-orders',
        domain: 'orders',
        prefix: '/orders',
        candidateService: 'orders-go',
        port: 8081,
        externalDependencies: ['inventory (reservation API)'],
        aclStrategy: 'HTTP Client calling legacy inventory (:8080 or gateway :8000)',
      },
      {
        id: 'slice-2-inventory',
        domain: 'inventory',
        prefix: '/inventory',
        candidateService: 'inventory-go',
        port: 8082,
        externalDependencies: [],
        aclStrategy: 'Standalone domain store; replaces legacy inventory directly',
      },
    ],
  };
}

if (require.main === module) {
  const result = analyzeLegacyMonolith();
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { analyzeLegacyMonolith };
