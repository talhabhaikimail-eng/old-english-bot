package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"time"
)

// The stdlib resolver can't query CAA records or report DNSSEC validation, so those two checks
// go through Cloudflare's DNS-over-HTTPS JSON API.
var dohClient = &http.Client{Timeout: 8 * time.Second}

type dohAnswer struct {
	AD     bool `json:"AD"`
	Status int  `json:"Status"`
	Answer []struct {
		Type int    `json:"type"`
		Data string `json:"data"`
	} `json:"Answer"`
}

func dohQuery(ctx context.Context, name, typ string) (*dohAnswer, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		"https://cloudflare-dns.com/dns-query?name="+url.QueryEscape(name)+"&type="+typ+"&do=1", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/dns-json")
	resp, err := dohClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var a dohAnswer
	if err := json.NewDecoder(resp.Body).Decode(&a); err != nil {
		return nil, err
	}
	return &a, nil
}

// hasCAA reports whether the registrable domain publishes a CAA record set.
func hasCAA(ctx context.Context, apex string) bool {
	a, err := dohQuery(ctx, apex, "CAA")
	if err != nil {
		return false
	}
	for _, r := range a.Answer {
		if r.Type == 257 {
			return true
		}
	}
	return false
}

func dnssecValidated(ctx context.Context, apex string) bool {
	a, err := dohQuery(ctx, apex, "A")
	return err == nil && a.AD
}
