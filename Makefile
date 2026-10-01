.PHONY: help up down smoke contract test demo build tidy fmt

help:
	@echo "strangler-lab targets:"
	@echo "  make demo      - run automated end-to-end agentic modernization demo"
	@echo "  make build     - build Go binaries"
	@echo "  make up        - start full modernization stack (gateway, legacy, orders-go, inventory-go)"
	@echo "  make smoke     - run multi-phase smoke suite (Phase 1, Phase 2, Shadow, Rollback)"
	@echo "  make contract  - run dual-domain contract tests (orders & inventory)"
	@echo "  make test      - contract + smoke"
	@echo "  make tidy      - go mod tidy for all modules"
	@echo "  make fmt       - gofmt Go sources"

build:
	cd services/orders-go && go build -o orders-go-bin .
	cd services/inventory-go && go build -o inventory-go-bin .
	cd gateway && go build -o gateway-bin .

demo:
	node agent/demo.js

up:
	node scripts/dev-up.js

smoke:
	node scripts/smoke.js --start

contract:
	cd contracts && npm test

test: contract smoke

tidy:
	cd services/orders-go && go mod tidy
	cd services/inventory-go && go mod tidy
	cd gateway && go mod tidy

fmt:
	gofmt -w services/orders-go services/inventory-go gateway
