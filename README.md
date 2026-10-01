# Strangler lab

An educational Node monolith → Go orders/inventory migration with a gateway, contract fixtures, read-only shadow comparisons, and state-preserving cutover in a controlled local process stack. This is an in-memory lab; it does not certify production reliability, crash recovery, decommissioning, or zero lost traffic.

## Try the maintained lifecycle

Prerequisites: Go 1.22+ and Node 22+. Source-only dependencies use the Go module locks and Node built-ins.

```bash
npm run demo   # contract verification → owned stack → sampled gates → cutover/rollback
npm test       # evidence tests, contracts, and controlled lifecycle smoke
```

The demo builds binaries into a private temporary directory, chooses free loopback ports, verifies each service's run identity and owns all child processes. It stops and removes its stack on completion/failure; it does not reuse or mutate an unrelated service on port 8000. `npm run up` keeps an owned local stack alive until Ctrl+C. Supply `LAB_ADMIN_TOKEN` before starting it if you need manual administrative access; otherwise the stack generates a private token for its own lifecycle. Tokens are not printed or forwarded with public requests.

The demo records observed results in `migration-ledger.json` and regenerates `MIGRATION_SCORECARD.md`. Historical entries are preserved with an explicit evidence correction. A hash chain detects edits relative to its prefix; it is not an immutable or authenticated audit record. Corrupt history fails closed; concurrent writers use an exclusive lock. An abandoned lock requires operator inspection/removal, not automatic expiration.

## What is verified

- Legacy and Go orders/inventory pass the checked consumer contracts. TAP output must contain a nonempty complete passing sample; missing, failed, skipped, or cancelled assertions reject acceptance. Test passage is not a claim of 100% behavior coverage.
- Shadow mode mirrors GET/HEAD only. It compares actual primary/candidate status and JSON body (or raw body when not JSON), includes intentional matching 4xx responses, and rejects transport/5xx failures as parity evidence. No order/reservation writes are replayed. Counts distinguish dispatched, completed, pending, matching, divergent and failed comparisons. Detail retention is capped at 100, while total divergence continues counting.
- Gates require every dispatched sample to complete, nonzero contracts/samples, zero observed differences/failures, and a finite measured candidate mean below the configured lab threshold of 50 ms. This mean is not a production SLA or tail-latency guarantee.
- Cutover blocks public gateway requests while copying the active orders/inventory state into the selected destination, then changes routing. Existing order IDs and stock quantities survive healthy-service promotion, rollback, and re-promotion. Failed transfer retains routing. Legacy orders with candidate inventory is rejected because that combination would split stock authority.
- Order creation reserves the entire inventory batch atomically, aggregating duplicate SKUs before validation. A failing second item or combined duplicate quantity does not consume earlier stock.

The maintained lifecycle checks both domain reads, four preserved order IDs, stock continuity, atomic failures, completed shadow comparison and healthy-service rollback. Gateway race tests cover body/status comparison, matching errors, transport failures, pending reset refusal, authorization, failed transfer and more than 100 divergences. Inventory tests call the shipped batch operation; evidence/ledger tests call the shipped evaluators and verifier.

## Boundaries before deployment

Services retain state only in memory. Direct calls to service ports bypass the gateway barrier; keep the lab isolated. The authenticated internal reservation callback bypasses the outer request barrier to avoid deadlock while an orders request already holds it; only trusted lab services should know the shared token. State transfer requires reachable source/destination services and is capped at 1 MiB. A source crash cannot be rolled back from an unavailable in-memory store. No durable database, idempotency across process crashes, distributed transaction protocol or production load test is provided.

Administrative/state/shadow endpoints require the shared token. Public application APIs are lab fixtures, not a full user-authorization system. Local processes bind to loopback; the optional Compose stack maps host ports to loopback and requires a token. Review service isolation, persistent storage, resource limits, credentials and image digests before any deployment.

The analyzer uses source-pattern heuristics rather than AST analysis. Its recommendations are a starting point; human review controls service decomposition and any actual monolith shutdown. Historical scorecards claiming broad compliance, zero divergence or zero dropped transactions were not supported by the earlier implementation and are explicitly superseded in the retained ledger.
