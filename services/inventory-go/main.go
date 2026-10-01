package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sync"
)

// Inventory domain service — second strangler slice.
// Same HTTP contract as legacy /inventory so cutover is config-driven.

type Stock struct {
	SKU      string `json:"sku"`
	Name     string `json:"name"`
	Quantity int    `json:"quantity"`
}

type reserveRequest struct {
	Quantity int `json:"quantity"`
}

type reserveResponse struct {
	SKU       string `json:"sku"`
	Reserved  int    `json:"reserved"`
	Remaining int    `json:"remaining"`
}

type errorBody struct {
	Error string `json:"error"`
}

type Store struct {
	mu    sync.Mutex
	stock map[string]*Stock
}

func NewStore() *Store {
	return &Store{
		stock: map[string]*Stock{
			"SKU-COFFEE-01":  {SKU: "SKU-COFFEE-01", Name: "House Blend Beans 1kg", Quantity: 100},
			"SKU-MUG-12":     {SKU: "SKU-MUG-12", Name: "Ceramic Mug 12oz", Quantity: 40},
			"SKU-FILTER-100": {SKU: "SKU-FILTER-100", Name: "Paper Filters (100pk)", Quantity: 200},
		},
	}
}

func (s *Store) Get(sku string) (Stock, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.stock[sku]
	if !ok {
		return Stock{}, false
	}
	return *st, true
}

func (s *Store) Reserve(sku string, qty int) (reserveResponse, error) {
	if qty < 1 {
		return reserveResponse{}, &httpError{status: http.StatusBadRequest, msg: "quantity (integer >= 1) required"}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.stock[sku]
	if !ok {
		return reserveResponse{}, &httpError{status: http.StatusNotFound, msg: "unknown sku: " + sku}
	}
	if st.Quantity < qty {
		return reserveResponse{}, &httpError{
			status: http.StatusConflict,
			msg:    fmt.Sprintf("insufficient stock for %s: have %d, need %d", sku, st.Quantity, qty),
		}
	}
	st.Quantity -= qty
	return reserveResponse{SKU: st.SKU, Reserved: qty, Remaining: st.Quantity}, nil
}

type httpError struct {
	status int
	msg    string
}

func (e *httpError) Error() string { return e.msg }

type Server struct {
	store *Store
	mux   *http.ServeMux
}

func NewServer(store *Store) *Server {
	s := &Server{store: store, mux: http.NewServeMux()}
	s.mux.HandleFunc("GET /health", s.handleHealth)
	s.mux.HandleFunc("GET /__state/inventory", s.handleState)
	s.mux.HandleFunc("PUT /__state/inventory", s.handleState)
	s.mux.HandleFunc("POST /inventory/reservations", s.handleBatch)
	s.mux.HandleFunc("GET /inventory/{sku}", s.handleGet)
	s.mux.HandleFunc("POST /inventory/{sku}/reserve", s.handleReserve)
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Served-By", "inventory-go")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

type BatchItem struct {
	SKU      string `json:"sku"`
	Quantity int    `json:"quantity"`
}

func (s *Store) ReserveBatch(items []BatchItem) error {
	if len(items) == 0 {
		return &httpError{400, "items (non-empty array) required"}
	}
	totals := make(map[string]int)
	for _, item := range items {
		if item.SKU == "" || item.Quantity < 1 || item.Quantity > int(^uint(0)>>1)-totals[item.SKU] {
			return &httpError{400, "invalid reservation item"}
		}
		totals[item.SKU] += item.Quantity
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for sku, qty := range totals {
		stock, ok := s.stock[sku]
		if !ok {
			return &httpError{404, "unknown sku: " + sku}
		}
		if stock.Quantity < qty {
			return &httpError{409, fmt.Sprintf("insufficient stock for %s: have %d, need %d", sku, stock.Quantity, qty)}
		}
	}
	for sku, qty := range totals {
		s.stock[sku].Quantity -= qty
	}
	return nil
}
func (s *Server) handleBatch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Items []BatchItem `json:"items"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
		writeJSON(w, 400, errorBody{Error: "invalid JSON body"})
		return
	}
	if err := s.store.ReserveBatch(body.Items); err != nil {
		e := err.(*httpError)
		writeJSON(w, e.status, errorBody{Error: e.msg})
		return
	}
	writeJSON(w, 200, map[string]bool{"reserved": true})
}
func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	token := os.Getenv("LAB_ADMIN_TOKEN")
	if token == "" || r.Header.Get("Authorization") != "Bearer "+token {
		writeJSON(w, 403, errorBody{Error: "admin authorization required"})
		return
	}
	if r.Method == http.MethodGet {
		s.store.mu.Lock()
		rows := make([]Stock, 0, len(s.store.stock))
		for _, row := range s.store.stock {
			rows = append(rows, *row)
		}
		s.store.mu.Unlock()
		writeJSON(w, 200, rows)
		return
	}
	var rows []Stock
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&rows); err != nil {
		writeJSON(w, 400, errorBody{Error: "invalid state"})
		return
	}
	replacement := make(map[string]*Stock)
	for _, row := range rows {
		if row.SKU == "" || row.Name == "" || row.Quantity < 0 {
			writeJSON(w, 400, errorBody{Error: "invalid state row"})
			return
		}
		if _, ok := replacement[row.SKU]; ok {
			writeJSON(w, 400, errorBody{Error: "duplicate state row"})
			return
		}
		copy := row
		replacement[row.SKU] = &copy
	}
	s.store.mu.Lock()
	s.store.stock = replacement
	s.store.mu.Unlock()
	writeJSON(w, 200, map[string]int{"imported": len(rows)})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "inventory-go", "runId": os.Getenv("LAB_RUN_ID")})
}

func (s *Server) handleGet(w http.ResponseWriter, r *http.Request) {
	sku := r.PathValue("sku")
	st, ok := s.store.Get(sku)
	if !ok {
		writeJSON(w, http.StatusNotFound, errorBody{Error: "sku not found"})
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleReserve(w http.ResponseWriter, r *http.Request) {
	sku := r.PathValue("sku")
	var req reserveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody{Error: "invalid JSON body"})
		return
	}
	resp, err := s.store.Reserve(sku, req.Quantity)
	if err != nil {
		if he, ok := err.(*httpError); ok {
			writeJSON(w, he.status, errorBody{Error: he.msg})
			return
		}
		writeJSON(w, http.StatusInternalServerError, errorBody{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func main() {
	port := envOr("PORT", "8082")
	store := NewStore()
	srv := NewServer(store)
	addr := envOr("HOST", "127.0.0.1") + ":" + port
	log.Printf("inventory-go listening on %s", addr)
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
