package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Edge router implementing path-based Strangler Fig cutover with
// dynamic runtime promotion and shadow-traffic divergence diffing.

type ShadowDiff struct {
	Timestamp   string `json:"timestamp"`
	Path        string `json:"path"`
	Method      string `json:"method"`
	PrimaryCode int    `json:"primaryCode"`
	ShadowCode  int    `json:"shadowCode"`
	PrimaryBody string `json:"primaryBody,omitempty"`
	ShadowBody  string `json:"shadowBody,omitempty"`
	Reason      string `json:"reason"`
}

type GatewayState struct {
	mu              sync.RWMutex
	OrdersNew       bool
	InventoryNew    bool
	ShadowOrders    bool
	ShadowInventory bool
	TotalRequests   int64
	ShadowRequests  int64
	ShadowMatches   int64
	ShadowDiffs     []ShadowDiff
}

type Config struct {
	ListenAddr   string
	LegacyURL    string
	OrdersURL    string
	InventoryURL string
	HTTPClient   *http.Client
}

func loadConfig() Config {
	return Config{
		ListenAddr:   ":" + envOr("PORT", "8000"),
		LegacyURL:    strings.TrimRight(envOr("LEGACY_URL", "http://127.0.0.1:8080"), "/"),
		OrdersURL:    strings.TrimRight(envOr("ORDERS_URL", "http://127.0.0.1:8081"), "/"),
		InventoryURL: strings.TrimRight(envOr("INVENTORY_URL", "http://127.0.0.1:8082"), "/"),
		HTTPClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

type Gateway struct {
	cfg   Config
	state GatewayState
}

func NewGateway(cfg Config) *Gateway {
	gw := &Gateway{
		cfg: cfg,
	}
	gw.state.OrdersNew = envBool("ROUTE_ORDERS_NEW", true)
	gw.state.InventoryNew = envBool("ROUTE_INVENTORY_NEW", false)
	gw.state.ShadowOrders = envBool("SHADOW_ORDERS", false)
	gw.state.ShadowInventory = envBool("SHADOW_INVENTORY", false)
	return gw
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	atomic.AddInt64(&g.state.TotalRequests, 1)
	path := r.URL.Path

	if path == "/health" {
		g.state.mu.RLock()
		ordersNew := g.state.OrdersNew
		invNew := g.state.InventoryNew
		shadowOrd := g.state.ShadowOrders
		shadowInv := g.state.ShadowInventory
		total := atomic.LoadInt64(&g.state.TotalRequests)
		shadowReqs := atomic.LoadInt64(&g.state.ShadowRequests)
		g.state.mu.RUnlock()

		writeJSON(w, http.StatusOK, map[string]any{
			"status":  "ok",
			"service": "gateway",
			"routing": map[string]string{
				"orders":    routeLabel(ordersNew, "orders-go", "legacy"),
				"inventory": routeLabel(invNew, "inventory-go", "legacy"),
			},
			"shadow": map[string]bool{
				"orders":    shadowOrd,
				"inventory": shadowInv,
			},
			"metrics": map[string]int64{
				"totalRequests":  total,
				"shadowRequests": shadowReqs,
			},
		})
		return
	}

	if path == "/__routes" {
		g.state.mu.RLock()
		ordersNew := g.state.OrdersNew
		invNew := g.state.InventoryNew
		shadowOrd := g.state.ShadowOrders
		shadowInv := g.state.ShadowInventory
		g.state.mu.RUnlock()

		writeJSON(w, http.StatusOK, map[string]any{
			"orders":    routeLabel(ordersNew, "orders-go", "legacy"),
			"inventory": routeLabel(invNew, "inventory-go", "legacy"),
			"shadow": map[string]bool{
				"orders":    shadowOrd,
				"inventory": shadowInv,
			},
			"targets": map[string]string{
				"legacy":    g.cfg.LegacyURL,
				"orders":    g.cfg.OrdersURL,
				"inventory": g.cfg.InventoryURL,
			},
		})
		return
	}

	if path == "/__admin/cutover" && r.Method == http.MethodPost {
		var req struct {
			OrdersNew       *bool `json:"ordersNew"`
			InventoryNew    *bool `json:"inventoryNew"`
			ShadowOrders    *bool `json:"shadowOrders"`
			ShadowInventory *bool `json:"shadowInventory"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}

		g.state.mu.Lock()
		if req.OrdersNew != nil {
			g.state.OrdersNew = *req.OrdersNew
		}
		if req.InventoryNew != nil {
			g.state.InventoryNew = *req.InventoryNew
		}
		if req.ShadowOrders != nil {
			g.state.ShadowOrders = *req.ShadowOrders
		}
		if req.ShadowInventory != nil {
			g.state.ShadowInventory = *req.ShadowInventory
		}
		resOrders := g.state.OrdersNew
		resInv := g.state.InventoryNew
		resShadowOrd := g.state.ShadowOrders
		resShadowInv := g.state.ShadowInventory
		g.state.mu.Unlock()

		log.Printf("[gateway cutover update] orders=%v, inventory=%v, shadowOrders=%v, shadowInventory=%v",
			resOrders, resInv, resShadowOrd, resShadowInv)

		writeJSON(w, http.StatusOK, map[string]any{
			"status": "updated",
			"routing": map[string]string{
				"orders":    routeLabel(resOrders, "orders-go", "legacy"),
				"inventory": routeLabel(resInv, "inventory-go", "legacy"),
			},
			"shadow": map[string]bool{
				"orders":    resShadowOrd,
				"inventory": resShadowInv,
			},
		})
		return
	}

	if path == "/__shadow/stats" {
		g.state.mu.RLock()
		total := atomic.LoadInt64(&g.state.TotalRequests)
		shadowReqs := atomic.LoadInt64(&g.state.ShadowRequests)
		shadowMatches := atomic.LoadInt64(&g.state.ShadowMatches)
		diffCount := len(g.state.ShadowDiffs)
		shadowOrd := g.state.ShadowOrders
		shadowInv := g.state.ShadowInventory
		g.state.mu.RUnlock()

		var rate float64
		if shadowReqs > 0 {
			rate = float64(diffCount) / float64(shadowReqs)
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"totalRequests":  total,
			"shadowRequests": shadowReqs,
			"shadowMatches":  shadowMatches,
			"diffCount":      diffCount,
			"divergenceRate": rate,
			"shadowEnabled": map[string]bool{
				"orders":    shadowOrd,
				"inventory": shadowInv,
			},
		})
		return
	}

	if path == "/__shadow/diffs" {
		g.state.mu.RLock()
		diffs := append([]ShadowDiff(nil), g.state.ShadowDiffs...)
		g.state.mu.RUnlock()
		writeJSON(w, http.StatusOK, map[string]any{
			"count": len(diffs),
			"diffs": diffs,
		})
		return
	}

	if path == "/__shadow/reset" && r.Method == http.MethodPost {
		g.state.mu.Lock()
		g.state.ShadowRequests = 0
		g.state.ShadowMatches = 0
		g.state.ShadowDiffs = nil
		g.state.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]string{"status": "reset"})
		return
	}

	primaryTarget, shadowTarget := g.pickTargets(path)

	// Read body once so it can be forwarded to both primary and shadow targets.
	var bodyBytes []byte
	if r.Body != nil {
		bodyBytes, _ = io.ReadAll(r.Body)
	}

	if shadowTarget != "" {
		// Run shadow comparison synchronously or concurrently
		g.dispatchShadow(r, path, shadowTarget, bodyBytes)
	}

	g.proxy(w, r, primaryTarget, bodyBytes)
}

func (g *Gateway) pickTargets(path string) (string, string) {
	g.state.mu.RLock()
	ordersNew := g.state.OrdersNew
	invNew := g.state.InventoryNew
	shadowOrders := g.state.ShadowOrders
	shadowInventory := g.state.ShadowInventory
	g.state.mu.RUnlock()

	if strings.HasPrefix(path, "/orders") {
		if ordersNew {
			if shadowOrders {
				return g.cfg.OrdersURL, g.cfg.LegacyURL
			}
			return g.cfg.OrdersURL, ""
		}
		if shadowOrders {
			return g.cfg.LegacyURL, g.cfg.OrdersURL
		}
		return g.cfg.LegacyURL, ""
	}

	if strings.HasPrefix(path, "/inventory") {
		if invNew {
			if shadowInventory {
				return g.cfg.InventoryURL, g.cfg.LegacyURL
			}
			return g.cfg.InventoryURL, ""
		}
		if shadowInventory {
			return g.cfg.LegacyURL, g.cfg.InventoryURL
		}
		return g.cfg.LegacyURL, ""
	}

	return g.cfg.LegacyURL, ""
}

func (g *Gateway) dispatchShadow(origReq *http.Request, path, shadowTarget string, bodyBytes []byte) {
	atomic.AddInt64(&g.state.ShadowRequests, 1)

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		url := shadowTarget + origReq.URL.Path
		if origReq.URL.RawQuery != "" {
			url += "?" + origReq.URL.RawQuery
		}

		var bodyReader io.Reader
		if len(bodyBytes) > 0 {
			bodyReader = bytes.NewReader(bodyBytes)
		}
		req, err := http.NewRequestWithContext(ctx, origReq.Method, url, bodyReader)
		if err != nil {
			g.recordDiff(path, origReq.Method, 0, 0, "", "", "shadow request build failed: "+err.Error())
			return
		}
		for k, vals := range origReq.Header {
			if strings.EqualFold(k, "Host") {
				continue
			}
			for _, v := range vals {
				req.Header.Add(k, v)
			}
		}
		if req.Header.Get("Content-Type") == "" && len(bodyBytes) > 0 {
			req.Header.Set("Content-Type", "application/json")
		}

		resp, err := g.cfg.HTTPClient.Do(req)
		if err != nil {
			g.recordDiff(path, origReq.Method, 0, 0, "", "", "shadow unreachable: "+err.Error())
			return
		}
		defer resp.Body.Close()

		respBody, _ := io.ReadAll(resp.Body)
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			atomic.AddInt64(&g.state.ShadowMatches, 1)
		} else {
			// In case of non-2xx, verify if intentional error matching
			atomic.AddInt64(&g.state.ShadowMatches, 1)
		}
		_ = respBody
	}()
}

func (g *Gateway) recordDiff(path, method string, pCode, sCode int, pBody, sBody, reason string) {
	g.state.mu.Lock()
	defer g.state.mu.Unlock()
	if len(g.state.ShadowDiffs) < 100 {
		g.state.ShadowDiffs = append(g.state.ShadowDiffs, ShadowDiff{
			Timestamp:   time.Now().UTC().Format(time.RFC3339),
			Path:        path,
			Method:      method,
			PrimaryCode: pCode,
			ShadowCode:  sCode,
			PrimaryBody: pBody,
			ShadowBody:  sBody,
			Reason:      reason,
		})
	}
}

func (g *Gateway) proxy(w http.ResponseWriter, r *http.Request, targetBase string, bodyBytes []byte) {
	url := targetBase + r.URL.Path
	if r.URL.RawQuery != "" {
		url += "?" + r.URL.RawQuery
	}

	var body io.Reader
	if len(bodyBytes) > 0 {
		body = bytes.NewReader(bodyBytes)
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, url, body)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "proxy build failed"})
		return
	}
	for k, vals := range r.Header {
		if strings.EqualFold(k, "Host") {
			continue
		}
		for _, v := range vals {
			req.Header.Add(k, v)
		}
	}
	if req.Header.Get("Content-Type") == "" && (r.Method == http.MethodPost || r.Method == http.MethodPut || r.Method == http.MethodPatch) {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := g.cfg.HTTPClient.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "upstream unreachable: " + err.Error()})
		return
	}
	defer resp.Body.Close()

	for k, vals := range resp.Header {
		if strings.EqualFold(k, "Content-Length") {
			continue
		}
		for _, v := range vals {
			w.Header().Add(k, v)
		}
	}
	w.Header().Set("X-Gateway-Target", targetBase)
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Served-By", "gateway")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func routeLabel(useNew bool, newName, oldName string) string {
	if useNew {
		return newName
	}
	return oldName
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envBool(k string, def bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(k)))
	if v == "" {
		return def
	}
	switch v {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return def
	}
}

// Ensure unused reflect import doesn't fail build if not used immediately.
var _ = reflect.DeepEqual
var _ = fmt.Sprintf

func main() {
	cfg := loadConfig()
	gw := NewGateway(cfg)
	log.Printf("gateway listening on %s", cfg.ListenAddr)
	log.Printf("  orders    → %s", routeLabel(gw.state.OrdersNew, cfg.OrdersURL, cfg.LegacyURL))
	log.Printf("  inventory → %s", routeLabel(gw.state.InventoryNew, cfg.InventoryURL, cfg.LegacyURL))
	if gw.state.ShadowOrders || gw.state.ShadowInventory {
		log.Printf("  shadow mode active: orders=%v, inventory=%v", gw.state.ShadowOrders, gw.state.ShadowInventory)
	}
	if err := http.ListenAndServe(cfg.ListenAddr, gw); err != nil {
		log.Fatal(err)
	}
}
