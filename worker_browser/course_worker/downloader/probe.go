package downloader

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

var ErrLinkNotWorking = errors.New("link not working")

// IsFatalLinkError checks if an error indicates a dead or broken link
// (e.g. 502 Bad Gateway, 404 Not Found, DNS resolution failure, connection refused).
func IsFatalLinkError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, ErrLinkNotWorking) {
		return true
	}
	msg := strings.ToLower(err.Error())
	fatalSubstrings := []string{
		"502", "503", "504", "404", "403", "410",
		"520", "521", "522", "523", "524", "525", "526",
		"bad gateway", "service unavailable", "gateway timeout", "not found",
		"forbidden", "next hop connection failed",
		"no such host", "name or service not known",
		"connection refused", "link not working",
		"status 502", "status 404", "status 503",
		"server error",
	}
	for _, s := range fatalSubstrings {
		if strings.Contains(msg, s) {
			return true
		}
	}
	return false
}

// ProbeLink performs a fast HTTP probe on a URL with a tight timeout (5s).
// It follows redirects and returns ErrLinkNotWorking if the link is dead or failing.
func (d *Downloader) ProbeLink(ctx context.Context, rawURL string) error {
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			DialContext: (&net.Dialer{
				Timeout:   3 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			TLSHandshakeTimeout:   3 * time.Second,
			ResponseHeaderTimeout: 4 * time.Second,
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("too many redirects")
			}
			req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
			req.Header.Set("Referer", "https://downloadlynet.ir/")
			return nil
		},
	}

	req, err := http.NewRequestWithContext(probeCtx, "GET", rawURL, nil)
	if err != nil {
		return fmt.Errorf("%w: invalid URL (%v)", ErrLinkNotWorking, err)
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
	req.Header.Set("Referer", "https://downloadlynet.ir/")
	req.Header.Set("Range", "bytes=0-0")

	resp, err := client.Do(req)
	if err != nil {
		if IsFatalLinkError(err) || probeCtx.Err() != nil {
			return fmt.Errorf("%w: %v", ErrLinkNotWorking, err)
		}
		return fmt.Errorf("%w: %v", ErrLinkNotWorking, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return fmt.Errorf("%w: HTTP %d %s", ErrLinkNotWorking, resp.StatusCode, resp.Status)
	}

	return nil
}

// ProbeAllLinks probes multiple URLs concurrently. If any fails with a fatal error,
// it returns ErrLinkNotWorking immediately.
func (d *Downloader) ProbeAllLinks(ctx context.Context, urls []string) error {
	if len(urls) == 0 {
		return nil
	}

	probeCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	var wg sync.WaitGroup
	var probeErr error
	var errOnce sync.Once

	for _, u := range urls {
		wg.Add(1)
		go func(targetURL string) {
			defer wg.Done()
			if err := d.ProbeLink(probeCtx, targetURL); err != nil {
				errOnce.Do(func() {
					probeErr = err
					cancel() // cancel all other ongoing probes
				})
			}
		}(u)
	}

	wg.Wait()
	return probeErr
}
