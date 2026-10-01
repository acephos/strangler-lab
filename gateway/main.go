package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"reflect"
	"strings"
	"sync"
	"time"
)

type ShadowDiff struct {
	Timestamp   string `json:"timestamp"`
	Path        string `json:"path"`
	Method      string `json:"method"`
	PrimaryCode int    `json:"primaryCode"`
	ShadowCode  int    `json:"shadowCode"`
	Reason      string `json:"reason"`
}
type GatewayState struct {
	mu                                                                                       sync.RWMutex
	OrdersNew, InventoryNew, ShadowOrders, ShadowInventory                                   bool
	TotalRequests, ShadowRequests, ShadowCompleted, ShadowMatches, ShadowFailures, DiffCount int64
	ShadowLatencyMs                                                                          float64
	ShadowDiffs                                                                              []ShadowDiff
}
type Config struct {
	ListenAddr, LegacyURL, OrdersURL, InventoryURL, AdminToken string
	HTTPClient                                                 *http.Client
}
type Gateway struct {
	cfg         Config
	state       GatewayState
	cutoverMu   sync.RWMutex
	shadowSlots chan struct{}
}

func loadConfig() Config {
	return Config{
		ListenAddr:   envOr("HOST", "127.0.0.1") + ":" + envOr("PORT", "8000"),
		LegacyURL:    strings.TrimRight(envOr("LEGACY_URL", "http://127.0.0.1:8080"), "/"),
		OrdersURL:    strings.TrimRight(envOr("ORDERS_URL", "http://127.0.0.1:8081"), "/"),
		InventoryURL: strings.TrimRight(envOr("INVENTORY_URL", "http://127.0.0.1:8082"), "/"),
		AdminToken:   os.Getenv("LAB_ADMIN_TOKEN"), HTTPClient: &http.Client{Timeout: 5 * time.Second},
	}
}
func NewGateway(cfg Config) *Gateway {
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 5 * time.Second}
	}
	g := &Gateway{cfg: cfg, shadowSlots: make(chan struct{}, 16)}
	g.state.OrdersNew = envBool("ROUTE_ORDERS_NEW", false)
	g.state.InventoryNew = envBool("ROUTE_INVENTORY_NEW", false)
	g.state.ShadowOrders = envBool("SHADOW_ORDERS", false)
	g.state.ShadowInventory = envBool("SHADOW_INVENTORY", false)
	return g
}
func (g *Gateway) tokenMatches(value string) bool {
	return g.cfg.AdminToken != "" && subtle.ConstantTimeCompare([]byte(value), []byte(g.cfg.AdminToken)) == 1
}
func (g *Gateway) authorized(r *http.Request) bool {
	return g.tokenMatches(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")) && strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ")
}
func (g *Gateway) routes() map[string]string {
	return map[string]string{"orders": routeLabel(g.state.OrdersNew, "orders-go", "legacy"), "inventory": routeLabel(g.state.InventoryNew, "inventory-go", "legacy")}
}
func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	g.state.mu.Lock()
	g.state.TotalRequests++
	g.state.mu.Unlock()
	path := r.URL.Path
	if path == "/health" || path == "/__routes" {
		g.state.mu.RLock()
		defer g.state.mu.RUnlock()
		writeJSON(w, 200, map[string]any{"status": "ok", "service": "gateway", "runId": os.Getenv("LAB_RUN_ID"), "routing": g.routes(), "shadow": map[string]bool{"orders": g.state.ShadowOrders, "inventory": g.state.ShadowInventory}})
		return
	}
	if strings.HasPrefix(path, "/__") {
		if !g.authorized(r) {
			writeJSON(w, 403, map[string]string{"error": "admin authorization required"})
			return
		}
		switch path {
		case "/__admin/cutover":
			if r.Method != http.MethodPost {
				writeJSON(w, 405, nil)
				return
			}
			g.cutover(w, r)
			return
		case "/__shadow/stats":
			g.state.mu.RLock()
			defer g.state.mu.RUnlock()
			rate, average := 0.0, 0.0
			if g.state.ShadowCompleted > 0 {
				rate = float64(g.state.DiffCount) / float64(g.state.ShadowCompleted)
				average = g.state.ShadowLatencyMs / float64(g.state.ShadowCompleted)
			}
			writeJSON(w, 200, map[string]any{"totalRequests": g.state.TotalRequests, "shadowRequests": g.state.ShadowRequests, "shadowCompleted": g.state.ShadowCompleted, "shadowPending": g.state.ShadowRequests - g.state.ShadowCompleted, "shadowMatches": g.state.ShadowMatches, "shadowFailures": g.state.ShadowFailures, "diffCount": g.state.DiffCount, "divergenceRate": rate, "averageLatencyMs": average})
			return
		case "/__shadow/diffs":
			g.state.mu.RLock()
			defer g.state.mu.RUnlock()
			writeJSON(w, 200, map[string]any{"count": g.state.DiffCount, "diffs": g.state.ShadowDiffs})
			return
		case "/__shadow/reset":
			if r.Method != http.MethodPost {
				writeJSON(w, 405, nil)
				return
			}
			// Drain public request handlers before resetting a measurement window.
			g.cutoverMu.Lock()
			defer g.cutoverMu.Unlock()
			g.state.mu.Lock()
			defer g.state.mu.Unlock()
			if g.state.ShadowRequests != g.state.ShadowCompleted {
				writeJSON(w, 409, map[string]string{"error": "shadow comparisons still pending"})
				return
			}
			g.state.ShadowRequests = 0
			g.state.ShadowCompleted = 0
			g.state.ShadowMatches = 0
			g.state.ShadowFailures = 0
			g.state.DiffCount = 0
			g.state.ShadowLatencyMs = 0
			g.state.ShadowDiffs = nil
			writeJSON(w, 200, map[string]string{"status": "reset"})
			return
		default:
			writeJSON(w, 404, nil)
			return
		}
	}
	// Orders call back through this gateway for atomic batch reservation. Authenticate
	// that narrow internal path to avoid RWMutex writer-priority deadlock during cutover.
	internal := r.Method == http.MethodPost && path == "/inventory/reservations" && g.tokenMatches(r.Header.Get("X-Lab-Internal"))
	if !internal {
		g.cutoverMu.RLock()
		defer g.cutoverMu.RUnlock()
	}
	primary, shadow := g.pickTargets(path)
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		writeJSON(w, 413, map[string]string{"error": "request body exceeds limit"})
		return
	}
	response, err := g.fetch(r.Context(), r.Method, primary+r.URL.RequestURI(), body, r.Header)
	if err != nil {
		writeJSON(w, 502, map[string]string{"error": "upstream unavailable or response too large"})
		return
	}
	for key, values := range response.header {
		if !strings.EqualFold(key, "Content-Length") {
			for _, value := range values {
				w.Header().Add(key, value)
			}
		}
	}
	w.Header().Set("X-Gateway-Target", primary)
	w.WriteHeader(response.code)
	_, _ = w.Write(response.body)
	// Read-only mirroring avoids replaying stock mutations and order creation.
	if shadow != "" && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
		g.dispatchShadow(r, shadow, response)
	}
}

type upstreamResponse struct {
	code   int
	body   []byte
	header http.Header
}

func (g *Gateway) fetch(ctx context.Context, method, url string, body []byte, headers http.Header) (upstreamResponse, error) {
	req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(body))
	if err != nil {
		return upstreamResponse{}, err
	}
	for key, values := range headers {
		if strings.EqualFold(key, "Host") || strings.EqualFold(key, "Authorization") || strings.EqualFold(key, "X-Lab-Internal") {
			continue
		}
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
	response, err := g.cfg.HTTPClient.Do(req)
	if err != nil {
		return upstreamResponse{}, err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(payload) > 1<<20 {
		return upstreamResponse{}, fmt.Errorf("response exceeds limit or read failed")
	}
	return upstreamResponse{response.StatusCode, payload, response.Header.Clone()}, nil
}
func bodiesEqual(a, b []byte) bool {
	var av, bv any
	if json.Unmarshal(a, &av) == nil && json.Unmarshal(b, &bv) == nil {
		return reflect.DeepEqual(av, bv)
	}
	return bytes.Equal(a, b)
}
func (g *Gateway) dispatchShadow(r *http.Request, target string, primary upstreamResponse) {
	method, path, uri, headers := r.Method, r.URL.Path, r.URL.RequestURI(), r.Header.Clone()
	g.state.mu.Lock()
	g.state.ShadowRequests++
	g.state.mu.Unlock()
	go func() {
		started := time.Now()
		reason := ""
		code := 0
		select {
		case g.shadowSlots <- struct{}{}:
			defer func() { <-g.shadowSlots }()
		default:
			reason = "shadow concurrency limit reached"
		}
		if reason == "" {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			shadow, err := g.fetch(ctx, method, target+uri, nil, headers)
			code = shadow.code
			switch {
			case err != nil:
				reason = "shadow transport failure"
			case primary.code >= 500 || shadow.code >= 500:
				reason = "server error cannot establish parity"
			case primary.code != shadow.code:
				reason = "status differs"
			case !bodiesEqual(primary.body, shadow.body):
				reason = "body differs"
			}
		}
		g.state.mu.Lock()
		defer g.state.mu.Unlock()
		g.state.ShadowCompleted++
		g.state.ShadowLatencyMs += float64(time.Since(started).Microseconds()) / 1000
		if reason == "" {
			g.state.ShadowMatches++
			return
		}
		g.state.DiffCount++
		if code == 0 || code >= 500 || primary.code >= 500 {
			g.state.ShadowFailures++
		}
		if len(g.state.ShadowDiffs) < 100 {
			g.state.ShadowDiffs = append(g.state.ShadowDiffs, ShadowDiff{time.Now().UTC().Format(time.RFC3339), path, method, primary.code, code, reason})
		}
	}()
}
func (g *Gateway) pickTargets(path string) (string, string) {
	g.state.mu.RLock()
	defer g.state.mu.RUnlock()
	if strings.HasPrefix(path, "/orders") {
		if g.state.OrdersNew {
			if g.state.ShadowOrders {
				return g.cfg.OrdersURL, g.cfg.LegacyURL
			}
			return g.cfg.OrdersURL, ""
		}
		if g.state.ShadowOrders {
			return g.cfg.LegacyURL, g.cfg.OrdersURL
		}
	}
	if strings.HasPrefix(path, "/inventory") {
		if g.state.InventoryNew {
			if g.state.ShadowInventory {
				return g.cfg.InventoryURL, g.cfg.LegacyURL
			}
			return g.cfg.InventoryURL, ""
		}
		if g.state.ShadowInventory {
			return g.cfg.LegacyURL, g.cfg.InventoryURL
		}
	}
	return g.cfg.LegacyURL, ""
}
func (g *Gateway) transfer(domain, from, to string) error {
	if from == to {
		return nil
	}
	url := from + "/__state/" + domain
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+g.cfg.AdminToken)
	response, err := g.cfg.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(body) > 1<<20 || response.StatusCode != 200 {
		return fmt.Errorf("state export failed")
	}
	req, err = http.NewRequest(http.MethodPut, to+"/__state/"+domain, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+g.cfg.AdminToken)
	req.Header.Set("Content-Type", "application/json")
	imported, err := g.cfg.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer imported.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(imported.Body, 1<<20))
	if imported.StatusCode != 200 {
		return fmt.Errorf("state import failed")
	}
	return nil
}
func (g *Gateway) cutover(w http.ResponseWriter, r *http.Request) {
	var req struct {
		OrdersNew       *bool `json:"ordersNew"`
		InventoryNew    *bool `json:"inventoryNew"`
		ShadowOrders    *bool `json:"shadowOrders"`
		ShadowInventory *bool `json:"shadowInventory"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"error": "invalid JSON"})
		return
	}
	g.cutoverMu.Lock()
	defer g.cutoverMu.Unlock()
	g.state.mu.RLock()
	orders, inventory, shadowOrders, shadowInventory := g.state.OrdersNew, g.state.InventoryNew, g.state.ShadowOrders, g.state.ShadowInventory
	pending := g.state.ShadowRequests - g.state.ShadowCompleted
	g.state.mu.RUnlock()
	if pending != 0 {
		writeJSON(w, 409, map[string]string{"error": "wait for shadow comparisons before cutover"})
		return
	}
	nextOrders, nextInventory := orders, inventory
	if req.OrdersNew != nil {
		nextOrders = *req.OrdersNew
	}
	if req.InventoryNew != nil {
		nextInventory = *req.InventoryNew
	}
	if !nextOrders && nextInventory {
		writeJSON(w, 409, map[string]string{"error": "legacy orders require legacy inventory"})
		return
	}
	transfers := []struct{ domain, from, to string }{}
	if nextOrders != orders {
		transfers = append(transfers, struct{ domain, from, to string }{"orders", routeLabel(orders, g.cfg.OrdersURL, g.cfg.LegacyURL), routeLabel(nextOrders, g.cfg.OrdersURL, g.cfg.LegacyURL)})
	}
	if nextInventory != inventory {
		transfers = append(transfers, struct{ domain, from, to string }{"inventory", routeLabel(inventory, g.cfg.InventoryURL, g.cfg.LegacyURL), routeLabel(nextInventory, g.cfg.InventoryURL, g.cfg.LegacyURL)})
	}
	if req.ShadowOrders != nil && *req.ShadowOrders && !shadowOrders {
		transfers = append(transfers, struct{ domain, from, to string }{"orders", routeLabel(nextOrders, g.cfg.OrdersURL, g.cfg.LegacyURL), routeLabel(!nextOrders, g.cfg.OrdersURL, g.cfg.LegacyURL)})
	}
	if req.ShadowInventory != nil && *req.ShadowInventory && !shadowInventory {
		transfers = append(transfers, struct{ domain, from, to string }{"inventory", routeLabel(nextInventory, g.cfg.InventoryURL, g.cfg.LegacyURL), routeLabel(!nextInventory, g.cfg.InventoryURL, g.cfg.LegacyURL)})
	}
	for _, transfer := range transfers {
		if err := g.transfer(transfer.domain, transfer.from, transfer.to); err != nil {
			writeJSON(w, 502, map[string]string{"error": "state transfer failed; routing retained"})
			return
		}
	}
	g.state.mu.Lock()
	defer g.state.mu.Unlock()
	g.state.OrdersNew = nextOrders
	g.state.InventoryNew = nextInventory
	if req.ShadowOrders != nil {
		g.state.ShadowOrders = *req.ShadowOrders
	}
	if req.ShadowInventory != nil {
		g.state.ShadowInventory = *req.ShadowInventory
	}
	writeJSON(w, 200, map[string]any{"status": "updated", "routing": g.routes()})
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Served-By", "gateway")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func routeLabel(use bool, new, old string) string {
	if use {
		return new
	}
	return old
}
func envOr(key, def string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return def
}
func envBool(key string, def bool) bool {
	switch strings.ToLower(os.Getenv(key)) {
	case "true", "1", "yes", "on":
		return true
	case "false", "0", "no", "off":
		return false
	}
	return def
}
func main() {
	cfg := loadConfig()
	if cfg.AdminToken == "" {
		log.Fatal("LAB_ADMIN_TOKEN is required for authenticated state transfer and cutover")
	}
	g := NewGateway(cfg)
	log.Printf("gateway listening on %s", cfg.ListenAddr)
	server := &http.Server{Addr: cfg.ListenAddr, Handler: g, ReadHeaderTimeout: 5 * time.Second}
	log.Fatal(server.ListenAndServe())
}
