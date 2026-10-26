package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"sort"
	"time"
)

// PageSpeedRun is a Lighthouse run via Google's PageSpeed Insights API, plus CrUX field data when
// Google has enough real-user traffic for the URL/origin.
type PageSpeedRun struct {
	Strategy      string            `json:"strategy"`
	Error         string            `json:"error,omitempty"`
	Scores        map[string]int    `json:"scores,omitempty"`
	Metrics       map[string]Metric `json:"metrics,omitempty"`
	Field         map[string]Metric `json:"field,omitempty"`
	FieldScope    string            `json:"fieldScope,omitempty"`
	Opportunities []PSIOpportunity  `json:"opportunities,omitempty"`
}

type Metric struct {
	Value    float64 `json:"value"`
	Display  string  `json:"display"`
	Category string  `json:"category,omitempty"` // FAST | AVERAGE | SLOW (field) or good/ni/poor (lab)
	Score    float64 `json:"score"`
}

type PSIOpportunity struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	SavingsMs float64 `json:"savingsMs"`
	Display   string  `json:"display,omitempty"`
	Score     float64 `json:"score"`
}

var psiClient = &http.Client{Timeout: 90 * time.Second}

func runPageSpeed(ctx context.Context, target, strategy, key string) PageSpeedRun {
	run := PageSpeedRun{Strategy: strategy}
	if key == "" {
		key = os.Getenv("PAGESPEED_API_KEY")
	}
	q := url.Values{}
	q.Set("url", target)
	q.Set("strategy", strategy)
	for _, c := range []string{"performance", "accessibility", "best-practices", "seo"} {
		q.Add("category", c)
	}
	if key != "" {
		q.Set("key", key)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://www.googleapis.com/pagespeedonline/v5/runPagespeed?"+q.Encode(), nil)
	if err != nil {
		run.Error = err.Error()
		return run
	}
	resp, err := psiClient.Do(req)
	if err != nil {
		run.Error = "PageSpeed API unreachable: " + simplifyNetErr(err).Error()
		return run
	}
	defer resp.Body.Close()
	var body struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		LoadingExperience       psiField `json:"loadingExperience"`
		OriginLoadingExperience psiField `json:"originLoadingExperience"`
		Lighthouse              struct {
			Categories map[string]struct {
				Score *float64 `json:"score"`
			} `json:"categories"`
			Audits map[string]struct {
				Title        string   `json:"title"`
				Score        *float64 `json:"score"`
				DisplayValue string   `json:"displayValue"`
				NumericValue float64  `json:"numericValue"`
				Details      struct {
					Type             string  `json:"type"`
					OverallSavingsMs float64 `json:"overallSavingsMs"`
				} `json:"details"`
			} `json:"audits"`
		} `json:"lighthouseResult"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		run.Error = "invalid PageSpeed response"
		return run
	}
	if body.Error != nil {
		run.Error = body.Error.Message
		if resp.StatusCode == 429 {
			run.Error = "PageSpeed API quota exceeded — add a free API key (PAGESPEED_API_KEY) for reliable results"
		}
		return run
	}
	run.Scores = map[string]int{}
	for k, c := range body.Lighthouse.Categories {
		if c.Score != nil {
			run.Scores[k] = int(*c.Score*100 + 0.5)
		}
	}
	run.Metrics = map[string]Metric{}
	for id, name := range map[string]string{
		"first-contentful-paint": "FCP", "largest-contentful-paint": "LCP", "total-blocking-time": "TBT",
		"cumulative-layout-shift": "CLS", "speed-index": "SI", "interactive": "TTI", "server-response-time": "TTFB",
	} {
		if a, ok := body.Lighthouse.Audits[id]; ok {
			m := Metric{Value: a.NumericValue, Display: a.DisplayValue}
			if a.Score != nil {
				m.Score = *a.Score
				m.Category = labScoreCategory(*a.Score)
			}
			run.Metrics[name] = m
		}
	}
	for id, a := range body.Lighthouse.Audits {
		if a.Details.Type == "opportunity" && a.Details.OverallSavingsMs >= 50 && a.Score != nil && *a.Score < 0.9 {
			run.Opportunities = append(run.Opportunities, PSIOpportunity{ID: id, Title: a.Title, SavingsMs: a.Details.OverallSavingsMs, Display: a.DisplayValue, Score: *a.Score})
		}
	}
	sort.Slice(run.Opportunities, func(i, j int) bool { return run.Opportunities[i].SavingsMs > run.Opportunities[j].SavingsMs })
	field, scope := body.LoadingExperience, "url"
	if len(field.Metrics) == 0 {
		field, scope = body.OriginLoadingExperience, "origin"
	}
	if len(field.Metrics) > 0 {
		run.FieldScope = scope
		run.Field = map[string]Metric{}
		for id, name := range map[string]string{
			"LARGEST_CONTENTFUL_PAINT_MS": "LCP", "INTERACTION_TO_NEXT_PAINT": "INP", "CUMULATIVE_LAYOUT_SHIFT_SCORE": "CLS",
			"FIRST_CONTENTFUL_PAINT_MS": "FCP", "EXPERIMENTAL_TIME_TO_FIRST_BYTE": "TTFB",
		} {
			if m, ok := field.Metrics[id]; ok {
				v := m.Percentile
				disp := fmt.Sprintf("%.0f ms", v)
				if name == "CLS" {
					v = v / 100
					disp = fmt.Sprintf("%.2f", v)
				} else if v >= 1000 {
					disp = fmt.Sprintf("%.1f s", v/1000)
				}
				run.Field[name] = Metric{Value: v, Display: disp, Category: m.Category}
			}
		}
	}
	return run
}

type psiField struct {
	Metrics map[string]struct {
		Percentile float64 `json:"percentile"`
		Category   string  `json:"category"`
	} `json:"metrics"`
}

func labScoreCategory(s float64) string {
	switch {
	case s >= 0.9:
		return "FAST"
	case s >= 0.5:
		return "AVERAGE"
	}
	return "SLOW"
}
