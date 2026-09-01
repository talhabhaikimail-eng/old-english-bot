package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"github.com/chromedp/chromedp"
)

// getCachedURL retrieves the cached URL from SQLite database using CLI
func getCachedURL() (string, error) {
	cmd := exec.Command("sqlite3", "cache.db", "SELECT value FROM cdp_cache WHERE key = 'cdp_url';")
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// setCachedURL saves the URL to SQLite database using CLI
func setCachedURL(val string) error {
	escapedVal := strings.ReplaceAll(val, "'", "''")
	query := "INSERT OR REPLACE INTO cdp_cache (key, value) VALUES ('cdp_url', '" + escapedVal + "');"
	cmd := exec.Command("sqlite3", "cache.db", query)
	return cmd.Run()
}

// initDB initializes the SQLite database and table using CLI
func initDB() error {
	cmd := exec.Command("sqlite3", "cache.db", "CREATE TABLE IF NOT EXISTS cdp_cache (key TEXT PRIMARY KEY, value TEXT);")
	return cmd.Run()
}

func main() {
	start := time.Now()

	// 1. Initialize SQLite Database
	if err := initDB(); err != nil {
		log.Fatalf("Failed to initialize SQLite: %v", err)
	}

	var cdpURL string
	var cached bool

	// 2. Try to get cached URL
	if val, err := getCachedURL(); err == nil && val != "" {
		cdpURL = val
		cached = true
		log.Printf("[%.2fs] Found cached WebSocket URL: %s", time.Since(start).Seconds(), cdpURL)
	}

	// Helper function to try connection
	tryConnect := func(urlStr string) (int, error) {
		// Set a short timeout for connection check (e.g. 2 seconds) so if cache is invalid it fails fast
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		allocCtx, allocCancel := chromedp.NewRemoteAllocator(ctx, urlStr, chromedp.NoModifyURL)
		defer allocCancel()

		connCtx, connCancel := chromedp.NewContext(allocCtx)
		defer connCancel()

		var result int
		err := chromedp.Run(connCtx, chromedp.Evaluate("1 + 1", &result))
		return result, err
	}

	var result int
	var err error
	if cached {
		log.Printf("[%.2fs] Attempting connection using cached URL...", time.Since(start).Seconds())
		result, err = tryConnect(cdpURL)
		if err != nil {
			log.Printf("[%.2fs] Cached URL connection failed: %v. Fetching a new URL...", time.Since(start).Seconds(), err)
			cached = false
		} else {
			log.Printf("[%.2fs] Successfully connected using cached URL! Result: %d", time.Since(start).Seconds(), result)
			log.Printf("Total execution time (cache hit): %.2fs", time.Since(start).Seconds())
			return
		}
	}

	// 3. Fetch dynamic WebSocket URL from /json if cache was missing or invalid
	if !cached {
		log.Printf("[%.2fs] Fetching dynamic WebSocket URL...", time.Since(start).Seconds())
		var wsURL string
		var targets []struct {
			Type string `json:"type"`
			URL  string `json:"webSocketDebuggerUrl"`
		}
		if hResp, err := http.Get("https://estimation-dreams-tue-stand.trycloudflare.com/json"); err == nil {
			json.NewDecoder(hResp.Body).Decode(&targets)
			hResp.Body.Close()
			for _, t := range targets {
				if t.Type == "page" {
					wsURL = t.URL
					break
				}
			}
		}

		if wsURL == "" {
			var version struct {
				URL string `json:"webSocketDebuggerUrl"`
			}
			if hResp, err := http.Get("https://estimation-dreams-tue-stand.trycloudflare.com/json/version"); err == nil {
				json.NewDecoder(hResp.Body).Decode(&version)
				hResp.Body.Close()
				wsURL = version.URL
			}
		}

		cdpURL = "wss://estimation-dreams-tue-stand.trycloudflare.com"
		if idx := strings.Index(wsURL, "/devtools/"); idx != -1 {
			cdpURL += wsURL[idx:]
		}
		log.Printf("[%.2fs] Resolved WebSocket URL: %s", time.Since(start).Seconds(), cdpURL)

		// Save to cache
		if err := setCachedURL(cdpURL); err != nil {
			log.Printf("[%.2fs] Warning: failed to cache URL to SQLite: %v", time.Since(start).Seconds(), err)
		}
	}

	// 4. Create an allocator with the newly fetched URL
	log.Printf("[%.2fs] Creating Remote Allocator...", time.Since(start).Seconds())
	allocCtx, cancel := chromedp.NewRemoteAllocator(context.Background(), cdpURL,
		chromedp.NoModifyURL,
	)
	defer cancel()

	// 5. Initialize the CDP context
	log.Printf("[%.2fs] Initializing chromedp Context...", time.Since(start).Seconds())
	ctx, cancel := chromedp.NewContext(allocCtx)
	defer cancel()

	// 6. Run verification
	log.Printf("[%.2fs] Running connection verification (evaluating 1+1)...", time.Since(start).Seconds())
	if err := chromedp.Run(ctx,
		chromedp.Evaluate("1 + 1", &result),
	); err != nil {
		log.Fatalf("[%.2fs] Failed to connect: %v", time.Since(start).Seconds(), err)
	}

	log.Printf("[%.2fs] Successfully connected! Result of 1+1: %d", time.Since(start).Seconds(), result)
	log.Printf("Total execution time (cache miss): %.2fs", time.Since(start).Seconds())
}
