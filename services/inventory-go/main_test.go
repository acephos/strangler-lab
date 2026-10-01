package main

import "testing"

func TestBatchReservationIsAtomicAndAggregatesDuplicateSKU(t *testing.T) {
	store := NewStore()
	before, _ := store.Get("SKU-COFFEE-01")
	for _, items := range [][]BatchItem{{{"SKU-COFFEE-01", 1}, {"UNKNOWN", 1}}, {{"SKU-COFFEE-01", 100}, {"SKU-COFFEE-01", 1}}} {
		if store.ReserveBatch(items) == nil {
			t.Fatal("invalid batch accepted")
		}
		after, _ := store.Get("SKU-COFFEE-01")
		if after.Quantity != before.Quantity {
			t.Fatal("partial batch changed stock")
		}
	}
	if err := store.ReserveBatch([]BatchItem{{"SKU-COFFEE-01", 2}, {"SKU-COFFEE-01", 3}}); err != nil {
		t.Fatal(err)
	}
	after, _ := store.Get("SKU-COFFEE-01")
	if after.Quantity != 95 {
		t.Fatal("duplicate quantities not aggregated")
	}
}
func TestReservationReceiptsDeduplicateAndRejectChangedPayload(t *testing.T) {
	store := NewStore()
	items := []BatchItem{{"SKU-COFFEE-01", 2}}
	if err := store.ReserveBatch(items, "fixture-key"); err != nil {
		t.Fatal(err)
	}
	if err := store.ReserveBatch(items, "fixture-key"); err != nil {
		t.Fatal(err)
	}
	after, _ := store.Get("SKU-COFFEE-01")
	if after.Quantity != 98 {
		t.Fatal("duplicate receipt reserved twice")
	}
	if store.ReserveBatch([]BatchItem{{"SKU-COFFEE-01", 3}}, "fixture-key") == nil {
		t.Fatal("changed payload reused receipt")
	}
	after, _ = store.Get("SKU-COFFEE-01")
	if after.Quantity != 98 {
		t.Fatal("rejected replay changed stock")
	}
}
