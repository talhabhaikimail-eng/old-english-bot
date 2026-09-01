package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"
)

func main() {
	portStr := os.Getenv("PORT")
	if portStr == "" {
		portStr = "8081"
	}

	http.HandleFunc("/api/scrape", handleScrape)
	http.HandleFunc("/health", handleHealth)

	log.Printf("Starting contact-scraper HTTP API service on port %s...", portStr)
	if err := http.ListenAndServe(":"+portStr, nil); err != nil {
		log.Fatalf("Failed to start contact-scraper server: %v", err)
	}
}

// handleHealth reports server status.
func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok"}`))
}

// handleScrape performs the scrape.
func handleScrape(w http.ResponseWriter, r *http.Request) {
	// Enable CORS
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	w.Header().Set("Content-Type", "application/json")

	targetURL := r.URL.Query().Get("url")
	if targetURL == "" {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "Missing 'url' query parameter"})
		return
	}

	// Optional query parameters
	maxPages := 50
	if mpStr := r.URL.Query().Get("max-pages"); mpStr != "" {
		if val, err := strconv.Atoi(mpStr); err == nil && val > 0 {
			maxPages = val
		}
	}

	workers := 10
	if wStr := r.URL.Query().Get("workers"); wStr != "" {
		if val, err := strconv.Atoi(wStr); err == nil && val > 0 {
			workers = val
		}
	}

	timeout := 30 * time.Second
	if tStr := r.URL.Query().Get("timeout"); tStr != "" {
		if val, err := time.ParseDuration(tStr); err == nil && val > 0 {
			timeout = val
		}
	}

	scraper, err := NewScraper(targetURL, maxPages, workers, timeout)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": fmt.Sprintf("Invalid target URL: %v", err)})
		return
	}

	log.Printf("Starting scrape request for URL: %s", targetURL)
	results, err := scraper.Start()
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": fmt.Sprintf("Scraping failure: %v", err)})
		return
	}

	log.Printf("Completed scrape request for URL: %s. Pages crawled: %d", targetURL, results.PagesCrawled)
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(results)
}
