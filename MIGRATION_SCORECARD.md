# Strangler lab — observed verification

This is a local in-memory exercise. The hash chain detects accidental edits against its existing prefix; it is not an immutable log, authenticated signature, or proof against a writer who replaces the whole file. New entries use full SHA-256; historical 16-character hashes remain unchanged. Corrupt ledgers fail closed and concurrent writers use an exclusive directory lock.

Latest controlled run: 2026-10-01T12:26:01.372Z

- Contract assertions: 24/24.
- Completed shadow reads: 6; matches: 6; divergences: 0; transport failures: 0.
- Preserved order IDs: 4; stock: 100 → 90.
- Healthy-service state transfer/rollback: 2.295 ms in this one run.

Checks:

- prior order IDs survive promotion and rollback
- stock continuity across all three routes
- multi-item and duplicate-SKU rejection is atomic
- idempotency replay survives cutover and rollback without consuming stock twice
- completed read-only shadow sample passes gate
- healthy-service rollback and re-promotion preserve state

Limitations:

- in-memory lab; no process-crash durability
- service-direct writes bypass the gateway barrier
- no production traffic, failure-rate or decommission certification
- rollback requires reachable source services to transfer state

Historical events before EVIDENCE_CORRECTION contain unsupported broad claims and do not establish current acceptance.

| # | Date | Event | Evidence status | Hash |
|---|---|---|---|---|
| 1 | 2026-09-30T18:16:29.440Z | DISCOVERY_COMPLETE | historical, superseded | 9ba7e87b52cb7162 |
| 2 | 2026-09-30T18:16:29.892Z | CONTRACT_VERIFIED | historical, superseded | 90b6542a05d86780 |
| 3 | 2026-09-30T18:16:30.436Z | SHADOW_AUDIT_PASSED | historical, superseded | 669c27a0ce91d65c |
| 4 | 2026-09-30T18:16:30.436Z | DELIVERY_CONTRACT_APPROVED | historical, superseded | 6e69d657f96ba656 |
| 5 | 2026-09-30T18:16:30.439Z | PHASE_1_CUTOVER | historical, superseded | 370be4272ea55a75 |
| 6 | 2026-09-30T18:16:30.442Z | PHASE_2_FULL_CUTOVER | historical, superseded | e9c62a0a3f37f615 |
| 7 | 2026-09-30T18:16:30.443Z | ROLLBACK_DRILL_VERIFIED | historical, superseded | 02d0926cb66e5d2a |
| 8 | 2026-09-30T18:17:22.732Z | DISCOVERY_COMPLETE | historical, superseded | 77386366bc9bd9cf |
| 9 | 2026-09-30T18:17:23.185Z | CONTRACT_VERIFIED | historical, superseded | 86484cf93b6ab2c9 |
| 10 | 2026-09-30T18:17:23.717Z | SHADOW_AUDIT_PASSED | historical, superseded | faf827b023ec63fb |
| 11 | 2026-09-30T18:17:23.718Z | DELIVERY_CONTRACT_APPROVED | historical, superseded | fd6455af53a0b5ae |
| 12 | 2026-09-30T18:17:23.721Z | PHASE_1_CUTOVER | historical, superseded | d55cb3834c638b0b |
| 13 | 2026-09-30T18:17:23.723Z | PHASE_2_FULL_CUTOVER | historical, superseded | ddeea34ae2b9afc5 |
| 14 | 2026-09-30T18:17:23.733Z | ROLLBACK_DRILL_VERIFIED | historical, superseded | bd51fe3e5df25347 |
| 15 | 2026-10-01T12:16:15.047Z | EVIDENCE_CORRECTION | correction/process | 04f82756c4ed1e477b68ba12858854a2c6166ed1b013465300f967b8bc894e2b |
| 16 | 2026-10-01T12:16:16.763Z | VALIDATED_LAB_RUN | controlled run | 47ac1fd4dc91fe06b9a3fdbb03402ca4a81237c70fbfd66aab98a43d20e044ce |
| 17 | 2026-10-01T12:19:38.171Z | VALIDATED_LAB_RUN | controlled run | 26ff8396dfe8023116e27a4feca7005fe0b0e00aa95fb3292ecab865c4d392b5 |
| 18 | 2026-10-01T12:26:01.372Z | VALIDATED_LAB_RUN | controlled run | bbd98d7f51062bca15ab714e84ecbdcef4694deb7df835d9a123f569ff9ac82a |
