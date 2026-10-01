package main

import (
	"bytes"
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

	"github.com/google/uuid"
)

// Order domain service — extracted slice of the legacy monolith.
// Speaks the same HTTP contract as legacy /orders so the gateway can cut over safely.

type OrderItem struct {
	SKU      string `json:"sku"`
	Quantity int    `json:"quantity"`
}

type Order struct {
	RequestID  string      `json:"requestId,omitempty"`
	ID         string      `json:"id"`
	CustomerID string      `json:"customerId"`
	Items      []OrderItem `json:"items"`
	Status     string      `json:"status"`
	CreatedAt  string      `json:"createdAt"`
}

type createOrderRequest struct {
	RequestID  string      `json:"requestId,omitempty"`
	CustomerID string      `json:"customerId"`
	Items      []OrderItem `json:"items"`
}

type errorBody struct {
	Error string `json:"error"`
}

// InventoryClient reserves stock in the inventory service (or legacy via gateway).
type InventoryClient interface {
	ReserveBatch(requestID string, items []OrderItem) error
}

type HTTPInventoryClient struct {
	BaseURL    string
	HTTPClient *http.Client
}

func (c *HTTPInventoryClient) ReserveBatch(requestID string, items []OrderItem) error {
	payload, err := json.Marshal(map[string]any{"items": items})
	if err != nil {
		return err
	}
	url := strings.TrimRight(c.BaseURL, "/") + "/inventory/reservations"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Lab-Internal", os.Getenv("LAB_ADMIN_TOKEN"))
	req.Header.Set("Idempotency-Key", requestID)
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	var eb errorBody
	if err := json.Unmarshal(body, &eb); err != nil || eb.Error == "" {
		eb.Error = fmt.Sprintf("inventory reserve failed (%d)", resp.StatusCode)
	}
	return &httpError{status: resp.StatusCode, msg: eb.Error}
}

type httpError struct {
	status int
	msg    string
}

func (e *httpError) Error() string { return e.msg }

type Store struct {
	mu     sync.RWMutex
	orders map[string]Order
	inv    InventoryClient
}

func NewStore(inv InventoryClient) *Store {
	return &Store{
		orders: make(map[string]Order),
		inv:    inv,
	}
}

func (s *Store) Create(req createOrderRequest) (Order, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if req.RequestID == "" {
		req.RequestID = uuid.NewString()
	}
	if len(req.RequestID) > 200 {
		return Order{}, &httpError{400, "invalid idempotency key"}
	}
	for _, prior := range s.orders {
		if prior.RequestID == req.RequestID {
			if prior.CustomerID != req.CustomerID || !reflect.DeepEqual(prior.Items, req.Items) {
				return Order{}, &httpError{409, "idempotency key reused with different order"}
			}
			return prior, nil
		}
	}

	if req.CustomerID == "" {
		return Order{}, &httpError{status: http.StatusBadRequest, msg: "customerId (string) required"}
	}
	if len(req.Items) == 0 {
		return Order{}, &httpError{status: http.StatusBadRequest, msg: "items (non-empty array) required"}
	}
	for _, it := range req.Items {
		if it.SKU == "" {
			return Order{}, &httpError{status: http.StatusBadRequest, msg: "each item needs sku"}
		}
		if it.Quantity < 1 {
			return Order{}, &httpError{status: http.StatusBadRequest, msg: "each item needs quantity >= 1"}
		}
	}

	if err := s.inv.ReserveBatch(req.RequestID, req.Items); err != nil {
		return Order{}, err
	}

	o := Order{
		RequestID:  req.RequestID,
		ID:         uuid.NewString(),
		CustomerID: req.CustomerID,
		Items:      append([]OrderItem(nil), req.Items...),
		Status:     "confirmed",
		CreatedAt:  time.Now().UTC().Format(time.RFC3339),
	}

	s.orders[o.ID] = o
	return o, nil
}

func (s *Store) Get(id string) (Order, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	o, ok := s.orders[id]
	return o, ok
}

type Server struct {
	store *Store
	mux   *http.ServeMux
}

func NewServer(store *Store) *Server {
	s := &Server{store: store, mux: http.NewServeMux()}
	s.mux.HandleFunc("GET /health", s.handleHealth)
	s.mux.HandleFunc("GET /__state/orders", s.handleState)
	s.mux.HandleFunc("PUT /__state/orders", s.handleState)
	s.mux.HandleFunc("POST /orders", s.handleCreateOrder)
	s.mux.HandleFunc("GET /orders/{id}", s.handleGetOrder)
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Served-By", "orders-go")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	token := os.Getenv("LAB_ADMIN_TOKEN")
	if token == "" || r.Header.Get("Authorization") != "Bearer "+token {
		writeJSON(w, 403, errorBody{Error: "admin authorization required"})
		return
	}
	if r.Method == http.MethodGet {
		s.store.mu.RLock()
		rows := make([]Order, 0, len(s.store.orders))
		for _, row := range s.store.orders {
			rows = append(rows, row)
		}
		s.store.mu.RUnlock()
		writeJSON(w, 200, rows)
		return
	}
	var rows []Order
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&rows); err != nil {
		writeJSON(w, 400, errorBody{Error: "invalid state"})
		return
	}
	replacement := make(map[string]Order)
	for _, row := range rows {
		_, dateErr := time.Parse(time.RFC3339, row.CreatedAt)
		if row.ID == "" || row.CustomerID == "" || row.Status != "confirmed" || len(row.Items) == 0 || dateErr != nil {
			writeJSON(w, 400, errorBody{Error: "invalid state row"})
			return
		}
		if _, exists := replacement[row.ID]; exists {
			writeJSON(w, 400, errorBody{Error: "duplicate state row"})
			return
		}
		for _, item := range row.Items {
			if item.SKU == "" || item.Quantity < 1 {
				writeJSON(w, 400, errorBody{Error: "invalid state item"})
				return
			}
		}
		replacement[row.ID] = row
	}
	s.store.mu.Lock()
	s.store.orders = replacement
	s.store.mu.Unlock()
	writeJSON(w, 200, map[string]int{"imported": len(rows)})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "orders-go", "runId": os.Getenv("LAB_RUN_ID")})
}

func (s *Server) handleCreateOrder(w http.ResponseWriter, r *http.Request) {
	var req createOrderRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: "invalid JSON body"})
		return
	}
	if key := r.Header.Get("Idempotency-Key"); key != "" {
		req.RequestID = key
	}
	order, err := s.store.Create(req)
	if err != nil {
		if he, ok := err.(*httpError); ok {
			writeJSON(w, he.status, errorBody{Error: he.msg})
			return
		}
		writeJSON(w, http.StatusBadGateway, errorBody{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, order)
}

func (s *Server) handleGetOrder(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	order, ok := s.store.Get(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, errorBody{Error: "order not found"})
		return
	}
	writeJSON(w, http.StatusOK, order)
}

func main() {
	port := envOr("PORT", "8081")
	// Point at legacy (or inventory-go) for reservations during partial cutover.
	invURL := envOr("INVENTORY_URL", "http://127.0.0.1:8080")

	inv := &HTTPInventoryClient{
		BaseURL: invURL,
		HTTPClient: &http.Client{
			Timeout: 5 * time.Second,
		},
	}
	store := NewStore(inv)
	srv := NewServer(store)

	addr := envOr("HOST", "127.0.0.1") + ":" + port
	log.Printf("orders-go listening on %s (inventory=%s)", addr, invURL)
	if err := http.ListenAndServe(addr, srv); err != nil {
		log.Fatal(err)
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
