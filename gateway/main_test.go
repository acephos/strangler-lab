package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func waitCompleted(t *testing.T, g *Gateway, n int64) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		g.state.mu.RLock()
		done := g.state.ShadowCompleted
		g.state.mu.RUnlock()
		if done == n {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("shadow comparisons did not complete")
}
func TestShadowComparesStatusBodyAndNeverMirrorsWrites(t *testing.T) {
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]int{"value": 1}) }))
	defer primary.Close()
	shadowWrites := 0
	shadow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			shadowWrites++
		}
		writeJSON(w, 200, map[string]int{"value": 2})
	}))
	defer shadow.Close()
	g := NewGateway(Config{LegacyURL: primary.URL, OrdersURL: shadow.URL, AdminToken: "fixture"})
	g.state.OrdersNew = false
	g.state.ShadowOrders = true
	for index := int64(1); index <= 105; index++ {
		g.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/orders/fixture", nil))
		waitCompleted(t, g, index)
	}
	g.state.mu.RLock()
	if g.state.DiffCount != 105 || len(g.state.ShadowDiffs) != 100 || g.state.ShadowMatches != 0 {
		t.Fatal("bounded diff details lost total divergence count")
	}
	g.state.mu.RUnlock()
	g.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/orders", bytes.NewBufferString(`{}`)))
	if shadowWrites != 0 {
		t.Fatal("write replayed to shadow")
	}
}
func TestIntentionalErrorParityAndReadFailure(t *testing.T) {
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 404, map[string]string{"error": "missing"}) }))
	defer primary.Close()
	shadow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 404, map[string]string{"error": "missing"}) }))
	g := NewGateway(Config{LegacyURL: primary.URL, OrdersURL: shadow.URL, AdminToken: "fixture"})
	g.state.OrdersNew = false
	g.state.ShadowOrders = true
	g.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/orders/missing", nil))
	waitCompleted(t, g, 1)
	if g.state.ShadowMatches != 1 {
		t.Fatal("equal intentional 404 must match")
	}
	shadow.Close()
	g.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/orders/missing", nil))
	waitCompleted(t, g, 2)
	if g.state.ShadowFailures != 1 || g.state.DiffCount != 1 {
		t.Fatal("transport failure counted as match")
	}
}
func TestAdminAuthAndFailedTransferRetainRouting(t *testing.T) {
	failed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer failed.Close()
	g := NewGateway(Config{LegacyURL: failed.URL, OrdersURL: failed.URL + "/candidate", AdminToken: "fixture"})
	g.state.OrdersNew = false
	request := httptest.NewRequest("POST", "/__admin/cutover", bytes.NewBufferString(`{"ordersNew":true}`))
	response := httptest.NewRecorder()
	g.ServeHTTP(response, request)
	if response.Code != 403 {
		t.Fatal("unauthenticated mutation accepted")
	}
	request = httptest.NewRequest("POST", "/__admin/cutover", bytes.NewBufferString(`{"ordersNew":true}`))
	request.Header.Set("Authorization", "Bearer fixture")
	response = httptest.NewRecorder()
	g.ServeHTTP(response, request)
	if response.Code != 502 || g.state.OrdersNew {
		t.Fatal("failed state transfer promoted routing")
	}
}
func TestPendingResetRefusedAndStatsContainCompletionCounts(t *testing.T) {
	g := NewGateway(Config{AdminToken: "fixture"})
	g.state.ShadowRequests = 1
	for _, path := range []string{"/__shadow/reset", "/__shadow/stats"} {
		request := httptest.NewRequest("POST", path, nil)
		request.Header.Set("Authorization", "Bearer fixture")
		response := httptest.NewRecorder()
		g.ServeHTTP(response, request)
		if path == "/__shadow/reset" && response.Code != 409 {
			t.Fatal("reset erased pending work")
		}
		if path == "/__shadow/stats" {
			var stats map[string]any
			_ = json.Unmarshal(response.Body.Bytes(), &stats)
			if fmt.Sprint(stats["shadowPending"]) != "1" {
				t.Fatal("pending count missing")
			}
		}
	}
}
func TestStatusMismatchCannotMatchEqualJSON(t *testing.T) {
	primary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 400, map[string]string{"error": "fixture"}) }))
	defer primary.Close()
	shadow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 404, map[string]string{"error": "fixture"}) }))
	defer shadow.Close()
	g := NewGateway(Config{LegacyURL: primary.URL, OrdersURL: shadow.URL, AdminToken: "fixture"})
	g.state.OrdersNew = false
	g.state.ShadowOrders = true
	g.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/orders/missing", nil))
	waitCompleted(t, g, 1)
	if g.state.ShadowMatches != 0 || g.state.DiffCount != 1 {
		t.Fatal("status mismatch counted as parity")
	}
}
