package main

import (
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Robots is a parsed robots.txt following Google's REP rules: the most specific user-agent group
// applies, and within it the longest matching rule wins (allow wins ties).
type Robots struct {
	groups   []robotsGroup
	Sitemaps []string
}

type robotsGroup struct {
	agents     []string
	rules      []robotsRule
	crawlDelay float64
}

type robotsRule struct {
	allow   bool
	pattern string
	re      *regexp.Regexp
}

func ParseRobots(body string) *Robots {
	r := &Robots{}
	var cur *robotsGroup
	lastWasAgent := false
	for _, line := range strings.Split(body, "\n") {
		if i := strings.Index(line, "#"); i >= 0 {
			line = line[:i]
		}
		line = strings.TrimSpace(line)
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(k))
		val := strings.TrimSpace(v)
		switch key {
		case "user-agent":
			if cur == nil || !lastWasAgent {
				r.groups = append(r.groups, robotsGroup{})
				cur = &r.groups[len(r.groups)-1]
			}
			cur.agents = append(cur.agents, strings.ToLower(val))
			lastWasAgent = true
			continue
		case "allow", "disallow":
			if cur != nil {
				if val == "" {
					// "Disallow:" with no path allows everything; it adds no rule.
					break
				}
				cur.rules = append(cur.rules, robotsRule{allow: key == "allow", pattern: val, re: robotsPattern(val)})
			}
		case "crawl-delay":
			if cur != nil {
				if d, err := strconv.ParseFloat(val, 64); err == nil {
					cur.crawlDelay = d
				}
			}
		case "sitemap":
			// Sitemap lines are independent of groups; the value itself contains a colon.
			if _, err := url.Parse(val); err == nil && val != "" {
				r.Sitemaps = append(r.Sitemaps, val)
			}
		}
		lastWasAgent = false
	}
	return r
}

func robotsPattern(p string) *regexp.Regexp {
	var b strings.Builder
	b.WriteString("^")
	end := strings.HasSuffix(p, "$")
	if end {
		p = strings.TrimSuffix(p, "$")
	}
	for _, part := range strings.Split(p, "*") {
		b.WriteString(regexp.QuoteMeta(part))
		b.WriteString(".*")
	}
	s := strings.TrimSuffix(b.String(), ".*")
	if end {
		s += "$"
	}
	re, err := regexp.Compile(s)
	if err != nil {
		return regexp.MustCompile("^$")
	}
	return re
}

// group returns the group for a user agent token (e.g. "googlebot"), falling back to "*".
func (r *Robots) group(agent string) *robotsGroup {
	agent = strings.ToLower(agent)
	var best *robotsGroup
	bestLen := -1
	for i := range r.groups {
		g := &r.groups[i]
		for _, a := range g.agents {
			if a == "*" {
				if bestLen < 0 {
					best, bestLen = g, 0
				}
				continue
			}
			if strings.HasPrefix(agent, a) && len(a) > bestLen {
				best, bestLen = g, len(a)
			}
		}
	}
	return best
}

// Allowed reports whether agent may fetch the path+query of u, and the rule that decided it.
func (r *Robots) Allowed(agent string, u *url.URL) (bool, string) {
	if r == nil {
		return true, ""
	}
	g := r.group(agent)
	if g == nil {
		return true, ""
	}
	target := u.EscapedPath()
	if u.RawQuery != "" {
		target += "?" + u.RawQuery
	}
	bestLen := -1
	allowed := true
	rule := ""
	for _, rl := range g.rules {
		if !rl.re.MatchString(target) {
			continue
		}
		l := len(rl.pattern)
		if l > bestLen || (l == bestLen && rl.allow && !allowed) {
			bestLen = l
			allowed = rl.allow
			if rl.allow {
				rule = "Allow: " + rl.pattern
			} else {
				rule = "Disallow: " + rl.pattern
			}
		}
	}
	return allowed, rule
}

func (r *Robots) CrawlDelay(agent string) float64 {
	if r == nil {
		return 0
	}
	if g := r.group(agent); g != nil {
		return g.crawlDelay
	}
	return 0
}

// AI crawler tokens that site owners commonly allow or block.
var aiCrawlers = []struct{ Token, Owner, Purpose string }{
	{"GPTBot", "OpenAI", "model training"},
	{"OAI-SearchBot", "OpenAI", "ChatGPT search"},
	{"ChatGPT-User", "OpenAI", "ChatGPT browsing"},
	{"ClaudeBot", "Anthropic", "model training"},
	{"Claude-SearchBot", "Anthropic", "Claude search"},
	{"Claude-User", "Anthropic", "Claude browsing"},
	{"PerplexityBot", "Perplexity", "Perplexity search"},
	{"Google-Extended", "Google", "Gemini training"},
	{"Applebot-Extended", "Apple", "Apple Intelligence training"},
	{"CCBot", "Common Crawl", "open dataset"},
	{"Bytespider", "ByteDance", "model training"},
	{"meta-externalagent", "Meta", "model training"},
	{"Amazonbot", "Amazon", "Alexa / search"},
	{"cohere-ai", "Cohere", "model training"},
	{"DuckAssistBot", "DuckDuckGo", "AI answers"},
}

type BotAccess struct {
	Token   string `json:"token"`
	Owner   string `json:"owner"`
	Purpose string `json:"purpose"`
	Allowed bool   `json:"allowed"`
	Rule    string `json:"rule,omitempty"`
}

func (r *Robots) BotAccessList(home *url.URL, bots []struct{ Token, Owner, Purpose string }) []BotAccess {
	out := make([]BotAccess, 0, len(bots))
	for _, b := range bots {
		ok, rule := r.Allowed(b.Token, home)
		out = append(out, BotAccess{Token: b.Token, Owner: b.Owner, Purpose: b.Purpose, Allowed: ok, Rule: rule})
	}
	return out
}

var searchCrawlers = []struct{ Token, Owner, Purpose string }{
	{"Googlebot", "Google", "web search"},
	{"Bingbot", "Microsoft", "Bing / Copilot"},
	{"Applebot", "Apple", "Siri / Spotlight"},
	{"YandexBot", "Yandex", "web search"},
	{"DuckDuckBot", "DuckDuckGo", "web search"},
	{"Baiduspider", "Baidu", "web search"},
}

// Agents lists the distinct user agents named in the file (for the report).
func (r *Robots) Agents() []string {
	seen := map[string]bool{}
	var out []string
	for _, g := range r.groups {
		for _, a := range g.agents {
			if !seen[a] {
				seen[a] = true
				out = append(out, a)
			}
		}
	}
	sort.Strings(out)
	return out
}

// DisallowsEverything reports a "Disallow: /" for the agent with no broader allow.
func (r *Robots) DisallowsEverything(agent string) bool {
	u, _ := url.Parse("https://x/")
	ok, _ := r.Allowed(agent, u)
	return !ok
}
