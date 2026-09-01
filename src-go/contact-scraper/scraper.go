package main

import (
	"encoding/xml"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/net/html"
)

// Sitemap XML structs
type SitemapLoc struct {
	Loc string `xml:"loc"`
}

type Urlset struct {
	XMLName xml.Name     `xml:"urlset"`
	Urls    []SitemapLoc `xml:"url"`
}

type Sitemapindex struct {
	XMLName  xml.Name     `xml:"sitemapindex"`
	Sitemaps []SitemapLoc `xml:"sitemap"`
}

// ScrapingResult represents the structured output of the scraper.
type ScrapingResult struct {
	TargetURL     string            `json:"targetUrl"`
	Emails        []string          `json:"emails"`
	Phones        []string          `json:"phones"`
	Socials       map[string]string `json:"socials"`
	PagesCrawled  int               `json:"pagesCrawled"`
	InternalLinks []string          `json:"internalLinks"`
}

// Scraper configures the scraping run.
type Scraper struct {
	BaseURL      *url.URL
	Client       *http.Client
	MaxPages     int
	MaxWorkers   int
	Timeout      time.Duration
	Visited      sync.Map
	CollectedUrl sync.Map // to return unique internal links
	Emails       sync.Map
	Phones       sync.Map
	Socials      sync.Map
	PageCount    int32
	mu           sync.Mutex
}

func NewScraper(targetURL string, maxPages int, maxWorkers int, timeout time.Duration) (*Scraper, error) {
	parsed, err := url.Parse(targetURL)
	if err != nil {
		return nil, err
	}
	if parsed.Scheme == "" {
		parsed.Scheme = "https"
	}

	return &Scraper{
		BaseURL:    parsed,
		Client:     &http.Client{Timeout: 10 * time.Second},
		MaxPages:   maxPages,
		MaxWorkers: maxWorkers,
		Timeout:    timeout,
	}, nil
}

// Start runs the scraping process.
func (s *Scraper) Start() (*ScrapingResult, error) {
	// Step 1: Discover sitemap URLs
	sitemapUrls := s.discoverSitemaps()

	// Step 2: Add homepage and sitemap URLs to target list
	toCrawl := []string{s.BaseURL.String()}
	for _, u := range sitemapUrls {
		if s.isInternal(u) {
			toCrawl = append(toCrawl, u)
		}
	}

	// Queue channels
	queue := make(chan string, s.MaxPages*5)
	done := make(chan struct{})

	var activeTasks int32
	var closeOnce sync.Once
	closeDone := func() {
		closeOnce.Do(func() {
			close(done)
		})
	}

	// Seed queue
	uniqueSeeds := make(map[string]bool)
	for _, u := range toCrawl {
		normalized := s.normalizeURL(u)
		if normalized != "" && !uniqueSeeds[normalized] {
			uniqueSeeds[normalized] = true
			s.Visited.Store(normalized, true) // Mark seed as visited/queued
			atomic.AddInt32(&activeTasks, 1)
			select {
			case queue <- normalized:
			default:
				atomic.AddInt32(&activeTasks, -1)
			}
		}
	}

	// If no seeds, close done and exit early
	if atomic.LoadInt32(&activeTasks) == 0 {
		closeDone()
	}

	// Spawn Workers
	var wg sync.WaitGroup
	for i := 0; i < s.MaxWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-done:
					return
				case targetURL := <-queue:
					// Check page limit
					s.mu.Lock()
					if s.PageCount >= int32(s.MaxPages) {
						s.mu.Unlock()
						if atomic.AddInt32(&activeTasks, -1) == 0 {
							closeDone()
						}
						continue
					}
					s.mu.Unlock()

					// Increment page count
					s.mu.Lock()
					s.PageCount++
					s.mu.Unlock()

					// Scrape
					newLinks := s.scrapePage(targetURL)

					// Feed new internal links back to channel
					for _, link := range newLinks {
						norm := s.normalizeURL(link)
						if norm == "" {
							continue
						}
						// Only enqueue if not visited yet
						if _, loaded := s.Visited.LoadOrStore(norm, true); !loaded {
							s.mu.Lock()
							currentCount := s.PageCount
							s.mu.Unlock()

							if currentCount < int32(s.MaxPages) {
								atomic.AddInt32(&activeTasks, 1)
								select {
								case queue <- norm:
								case <-done:
									atomic.AddInt32(&activeTasks, -1)
								default:
									// Queue full, discard
									atomic.AddInt32(&activeTasks, -1)
								}
							}
						}
					}

					// Finished processing this page, decrement active tasks
					if atomic.AddInt32(&activeTasks, -1) == 0 {
						closeDone()
					}
				}
			}
		}()
	}

	// Wait or run with total timeout
	time.AfterFunc(s.Timeout, func() {
		closeDone()
	})

	wg.Wait()

	// Collect final results
	res := &ScrapingResult{
		TargetURL:     s.BaseURL.String(),
		Emails:        make([]string, 0),
		Phones:        make([]string, 0),
		Socials:       make(map[string]string),
		InternalLinks: make([]string, 0),
	}

	s.Emails.Range(func(k, v interface{}) bool {
		res.Emails = append(res.Emails, k.(string))
		return true
	})

	s.Phones.Range(func(k, v interface{}) bool {
		res.Phones = append(res.Phones, k.(string))
		return true
	})

	s.Socials.Range(func(k, v interface{}) bool {
		res.Socials[k.(string)] = v.(string)
		return true
	})

	s.CollectedUrl.Range(func(k, v interface{}) bool {
		res.InternalLinks = append(res.InternalLinks, k.(string))
		return true
	})

	res.PagesCrawled = int(s.PageCount)

	return res, nil
}

// discoverSitemaps tries to find and parse sitemaps.
func (s *Scraper) discoverSitemaps() []string {
	var urls []string
	sitemapPaths := []string{"/sitemap.xml", "/sitemap_index.xml"}

	for _, p := range sitemapPaths {
		sUrl := s.BaseURL.ResolveReference(&url.URL{Path: p}).String()
		req, err := http.NewRequest("GET", sUrl, nil)
		if err != nil {
			continue
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
		req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")

		resp, err := s.Client.Do(req)
		if err != nil {
			continue
		}

		if resp.StatusCode == http.StatusOK {
			found := s.parseSitemap(resp.Body)
			urls = append(urls, found...)
		}
		resp.Body.Close()
	}
	return urls
}

// parseSitemap parses urlset or sitemapindex xml files.
func (s *Scraper) parseSitemap(r io.Reader) []string {
	data, err := io.ReadAll(r)
	if err != nil {
		return nil
	}

	var urls []string

	// Try Sitemap Index first
	var idx Sitemapindex
	if err := xml.Unmarshal(data, &idx); err == nil && len(idx.Sitemaps) > 0 {
		for _, sm := range idx.Sitemaps {
			// Fetch nested sitemap (up to 3 nested to avoid infinite loops)
			req, err := http.NewRequest("GET", sm.Loc, nil)
			if err != nil {
				continue
			}
			req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
			
			resp, err := s.Client.Do(req)
			if err == nil {
				if resp.StatusCode == http.StatusOK {
					var subSet Urlset
					subData, _ := io.ReadAll(resp.Body)
					if err := xml.Unmarshal(subData, &subSet); err == nil {
						for _, u := range subSet.Urls {
							urls = append(urls, u.Loc)
						}
					}
				}
				resp.Body.Close()
			}
		}
		return urls
	}

	// Try normal urlset
	var set Urlset
	if err := xml.Unmarshal(data, &set); err == nil {
		for _, u := range set.Urls {
			urls = append(urls, u.Loc)
		}
	}
	return urls
}

// scrapePage fetches page, parses html, collects contact details and extracts internal links.
func (s *Scraper) scrapePage(targetURL string) []string {
	req, err := http.NewRequest("GET", targetURL, nil)
	if err != nil {
		return nil
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8")
	req.Header.Set("Accept-Language", "en-US,en;q=0.5")

	resp, err := s.Client.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil
	}

	var (
		internalLinks []string
		bodyHrefs     []string
		inIgnoredTag  bool
	)

	ignoredTags := map[string]bool{
		"script":   true,
		"style":    true,
		"noscript": true,
		"head":     true,
		"iframe":   true,
	}

	tokenizer := html.NewTokenizer(resp.Body)
	for {
		tokenType := tokenizer.Next()
		if tokenType == html.ErrorToken {
			break
		}

		switch tokenType {
		case html.StartTagToken, html.SelfClosingTagToken:
			token := tokenizer.Token()
			tagName := strings.ToLower(token.Data)

			if ignoredTags[tagName] {
				inIgnoredTag = true
			}

			if tagName == "a" {
				for _, attr := range token.Attr {
					if attr.Key == "href" {
						link := attr.Val
						bodyHrefs = append(bodyHrefs, link)

						lowerLink := strings.ToLower(strings.TrimSpace(link))

						// Extract email from mailto link
						if strings.HasPrefix(lowerLink, "mailto:") {
							emailPart := strings.TrimPrefix(link, "mailto:")
							if idx := strings.Index(emailPart, "?"); idx != -1 {
								emailPart = emailPart[:idx]
							}
							emailPart = strings.TrimSpace(emailPart)
							emails := ExtractEmails(emailPart, s.BaseURL.Host)
							for _, email := range emails {
								s.Emails.Store(email, true)
							}
						}

						// Extract phone from tel link
						if strings.HasPrefix(lowerLink, "tel:") {
							phonePart := strings.TrimPrefix(link, "tel:")
							phonePart = strings.TrimSpace(phonePart)
							phones := ExtractPhones(phonePart)
							for _, phone := range phones {
								s.Phones.Store(phone, true)
							}
						}

						// Check if link is internal
						resolved := s.resolveURL(link)
						if resolved != "" && s.isInternal(resolved) {
							internalLinks = append(internalLinks, resolved)
							s.CollectedUrl.Store(resolved, true)
						}
					}
				}
			}

		case html.EndTagToken:
			token := tokenizer.Token()
			tagName := strings.ToLower(token.Data)
			if ignoredTags[tagName] {
				inIgnoredTag = false
			}

		case html.TextToken:
			if !inIgnoredTag {
				text := tokenizer.Token().Data
				
				// Extract emails
				emails := ExtractEmails(text, s.BaseURL.Host)
				for _, email := range emails {
					s.Emails.Store(email, true)
				}

				// Extract phones
				phones := ExtractPhones(text)
				for _, phone := range phones {
					s.Phones.Store(phone, true)
				}
			}
		}
	}

	// Extract socials from all hrefs on the page
	socials := ExtractSocials(bodyHrefs)
	for k, v := range socials {
		s.Socials.Store(k, v)
	}

	return internalLinks
}

func (s *Scraper) isInternal(targetURL string) bool {
	parsed, err := url.Parse(targetURL)
	if err != nil {
		return false
	}
	h1 := strings.TrimPrefix(strings.ToLower(parsed.Host), "www.")
	h2 := strings.TrimPrefix(strings.ToLower(s.BaseURL.Host), "www.")
	return h1 == h2 || parsed.Host == ""
}

func (s *Scraper) resolveURL(href string) string {
	u, err := url.Parse(href)
	if err != nil {
		return ""
	}
	resolved := s.BaseURL.ResolveReference(u)
	return resolved.String()
}

func (s *Scraper) normalizeURL(u string) string {
	parsed, err := url.Parse(u)
	if err != nil {
		return ""
	}
	// Strip fragments
	parsed.Fragment = ""
	// Normalize path (strip trailing slash)
	parsed.Path = strings.TrimSuffix(parsed.Path, "/")
	return parsed.String()
}
