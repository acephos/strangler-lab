package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestUncertainReservationReceiptUsesSameKeyOnRetry(t *testing.T) {
	calls := 0
	received := ""
	inventory := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Items []OrderItem `json:"items"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		key := r.Header.Get("Idempotency-Key")
		if key != "fixture-key" || len(body.Items) != 1 {
			t.Error("reservation identity/payload missing")
		}
		calls++
		if calls == 1 {
			received = key
			connection, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			_ = connection.Close()
			return
		}
		if received != key {
			t.Error("retry changed reservation identity")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"reserved":true}`))
	}))
	defer inventory.Close()
	store := NewStore(&HTTPInventoryClient{BaseURL: inventory.URL, HTTPClient: inventory.Client()})
	request := createOrderRequest{RequestID: "fixture-key", CustomerID: "fixture", Items: []OrderItem{{"SKU-COFFEE-01", 1}}}
	if _, err := store.Create(request); err == nil {
		t.Fatal("lost reservation response treated as confirmation")
	}
	order, err := store.Create(request)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := store.Create(request)
	if err != nil || replay.ID != order.ID || calls != 2 {
		t.Fatal("confirmed retry repeated reservation/order")
	}
	request.Items = []OrderItem{{"SKU-COFFEE-01", 2}}
	if _, err := store.Create(request); err == nil {
		t.Fatal("different payload reused key")
	}
}
