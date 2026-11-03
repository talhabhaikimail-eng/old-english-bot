package main

import "time"

// Options configure one audit. Zero values are replaced by defaults in normalize().
type Options struct {
	URL               string   `json:"url"`
	MaxPages          int      `json:"maxPages"`
	MaxDepth          int      `json:"maxDepth"`
	Concurrency       int      `json:"concurrency"`
	UserAgent         string   `json:"userAgent"` // preset key (see userAgents) or a custom string
	RespectRobots     *bool    `json:"respectRobots,omitempty"`
	IncludeSubdomains bool     `json:"includeSubdomains"`
	CheckExternal     *bool    `json:"checkExternal,omitempty"`
	CheckResources    *bool    `json:"checkResources,omitempty"`
	UseSitemaps       *bool    `json:"useSitemaps,omitempty"`
	StripQuery        bool     `json:"stripQuery"`
	CrawlDelayMs      int      `json:"crawlDelayMs"`
	TimeoutSec        int      `json:"timeoutSec"`
	Include           []string `json:"include,omitempty"`
	Exclude           []string `json:"exclude,omitempty"`
	PageSpeed         *bool    `json:"pageSpeed,omitempty"`
	PageSpeedKey      string   `json:"pageSpeedKey,omitempty"`
	Keyword           string   `json:"keyword,omitempty"` // optional focus keyword checked on every page

	// Scope & discovery.
	Mode          string   `json:"mode,omitempty"`          // crawl (default) | sitemap | list
	URLs          []string `json:"urls,omitempty"`          // list mode: exact URLs to audit
	SubfolderOnly bool     `json:"subfolderOnly,omitempty"` // only crawl below the start URL's folder
	IgnoreParams  []string `json:"ignoreParams,omitempty"`  // query params to drop (supports prefix*: utm_*)
	RetryErrors   *bool    `json:"retryErrors,omitempty"`   // retry timeouts / 502-504 once before reporting

	// Authenticated / staging crawls. Values are redacted in stored reports.
	Headers  map[string]string `json:"headers,omitempty"`
	AuthUser string            `json:"authUser,omitempty"`
	AuthPass string            `json:"authPass,omitempty"`

	// Reporting.
	DisabledChecks []string      `json:"disabledChecks,omitempty"` // issue ids or "category:<id>"
	Thresholds     *Thresholds   `json:"thresholds,omitempty"`
	CustomSearch   []SearchRule  `json:"customSearch,omitempty"`
	Extract        []ExtractRule `json:"extract,omitempty"`

	// Third-party verification.
	Verify         *VerifyOptions `json:"verify,omitempty"`
	ReverifyBroken *bool          `json:"reverifyBroken,omitempty"` // re-check broken links with a browser UA
}

// Thresholds tune the numeric checks; zero fields fall back to defaults.
type Thresholds struct {
	TitleMin    int `json:"titleMin,omitempty"`
	TitleMax    int `json:"titleMax,omitempty"`
	DescMin     int `json:"descMin,omitempty"`
	DescMax     int `json:"descMax,omitempty"`
	ThinWords   int `json:"thinWords,omitempty"`
	SlowTTFBMs  int `json:"slowTtfbMs,omitempty"`
	SlowLoadMs  int `json:"slowLoadMs,omitempty"`
	LargeHTMLKB int `json:"largeHtmlKb,omitempty"`
	LargeImgKB  int `json:"largeImageKb,omitempty"`
	MaxDOM      int `json:"maxDom,omitempty"`
	DeepClicks  int `json:"deepClicks,omitempty"`
}

var defaultThresholds = Thresholds{TitleMin: 30, TitleMax: 60, DescMin: 70, DescMax: 160, ThinWords: 200, SlowTTFBMs: 800,
	SlowLoadMs: 3000, LargeHTMLKB: 500, LargeImgKB: 200, MaxDOM: 1500, DeepClicks: 4}

// SearchRule is a Screaming Frog-style custom search: pages that contain (or lack) a pattern.
type SearchRule struct {
	Name    string `json:"name"`
	Pattern string `json:"pattern"`
	Regex   bool   `json:"regex,omitempty"`
	Absent  bool   `json:"absent,omitempty"` // report pages that do NOT contain the pattern
	InText  bool   `json:"inText,omitempty"` // match visible text instead of raw HTML
}

// ExtractRule captures data from every page with a regex (first capture group, or the whole match).
type ExtractRule struct {
	Name  string `json:"name"`
	Regex string `json:"regex"`
}

type VerifyOptions struct {
	W3C          *bool `json:"w3c,omitempty"`          // validator.w3.org Nu HTML checker
	W3CPages     int   `json:"w3cPages,omitempty"`     // pages to validate (top by link score), default 5
	Observatory  *bool `json:"observatory,omitempty"`  // Mozilla HTTP Observatory
	SafeBrowsing *bool `json:"safeBrowsing,omitempty"` // Google Safe Browsing (needs an API key)
	RDAP         *bool `json:"rdap,omitempty"`         // domain registration data
	Wayback      *bool `json:"wayback,omitempty"`      // Internet Archive history
	Tranco       *bool `json:"tranco,omitempty"`       // Tranco popularity rank
	GreenWeb     *bool `json:"greenWeb,omitempty"`     // Green Web Foundation hosting check
	SSLLabs      bool  `json:"sslLabs,omitempty"`      // Qualys SSL Labs (slow, opt-in)
}

func (v *VerifyOptions) on(p func(*VerifyOptions) *bool) bool {
	if v == nil {
		return true
	}
	return boolOr(p(v), true)
}

func boolOr(p *bool, def bool) bool {
	if p == nil {
		return def
	}
	return *p
}

var userAgents = map[string]string{
	"default":          "Mozilla/5.0 (compatible; DataNodesSiteAuditor/1.0; +https://talhacodes.site)",
	"googlebot":        "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
	"googlebot-mobile": "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.126 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
	"bingbot":          "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
	"chrome":           "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
	"iphone":           "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
}

// robots.txt token used for each preset.
var robotsTokens = map[string]string{
	"googlebot": "Googlebot", "googlebot-mobile": "Googlebot", "bingbot": "Bingbot",
}

type Heading struct {
	Level int    `json:"level"`
	Text  string `json:"text"`
}

type Hreflang struct {
	Lang string `json:"lang"`
	URL  string `json:"url"`
}

type ImageRef struct {
	Src    string `json:"src"`
	Alt    string `json:"alt"`
	HasAlt bool   `json:"hasAlt"`
	Width  string `json:"width,omitempty"`
	Height string `json:"height,omitempty"`
	Lazy   bool   `json:"lazy"`
	Srcset bool   `json:"srcset"`
	InLink bool   `json:"inLink"`
	Status int    `json:"status,omitempty"`
	Size   int64  `json:"size,omitempty"`
	Format string `json:"format,omitempty"`
}

type LinkRef struct {
	URL      string `json:"url"`
	Anchor   string `json:"anchor"`
	Rel      string `json:"rel,omitempty"`
	Internal bool   `json:"internal"`
	Nofollow bool   `json:"nofollow"`
	ImgLink  bool   `json:"imgLink,omitempty"`
}

type SchemaItem struct {
	Format string   `json:"format"` // json-ld | microdata | rdfa
	Types  []string `json:"types"`
	Errors []string `json:"errors,omitempty"`
	Raw    string   `json:"raw,omitempty"`
}

type Keyword struct {
	Term    string  `json:"term"`
	Count   int     `json:"count"`
	Density float64 `json:"density"`
}

type Timing struct {
	DNSMs     int `json:"dnsMs"`
	ConnectMs int `json:"connectMs"`
	TLSMs     int `json:"tlsMs"`
	TTFBMs    int `json:"ttfbMs"`
	TotalMs   int `json:"totalMs"`
}

// Page is everything collected for one crawled URL.
type Page struct {
	URL            string              `json:"url"`
	Status         int                 `json:"status"`
	Error          string              `json:"error,omitempty"`
	BlockedRobots  bool                `json:"blockedByRobots,omitempty"`
	RobotsRule     string              `json:"robotsRule,omitempty"`
	ContentType    string              `json:"contentType,omitempty"`
	Proto          string              `json:"proto,omitempty"`
	Depth          int                 `json:"depth"`
	FoundFrom      string              `json:"foundFrom,omitempty"`
	RedirectTo     string              `json:"redirectTo,omitempty"`
	Size           int                 `json:"size"`
	TransferSize   int64               `json:"transferSize"`
	Compression    string              `json:"compression,omitempty"`
	Timing         Timing              `json:"timing"`
	Headers        map[string]string   `json:"headers,omitempty"`
	IsHTML         bool                `json:"isHtml"`
	Indexable      bool                `json:"indexable"`
	IndexReason    string              `json:"indexReason,omitempty"`
	Title          string              `json:"title"`
	TitleCount     int                 `json:"titleCount"`
	TitlePx        int                 `json:"titlePx"`
	Description    string              `json:"description"`
	DescCount      int                 `json:"descCount"`
	DescPx         int                 `json:"descPx"`
	MetaRobots     string              `json:"metaRobots,omitempty"`
	XRobots        string              `json:"xRobots,omitempty"`
	Canonical      string              `json:"canonical,omitempty"`
	CanonicalCount int                 `json:"canonicalCount"`
	CanonicalRaw   string              `json:"canonicalRaw,omitempty"`
	H1             []string            `json:"h1"`
	Headings       []Heading           `json:"headings,omitempty"`
	Lang           string              `json:"lang,omitempty"`
	Charset        string              `json:"charset,omitempty"`
	Viewport       string              `json:"viewport,omitempty"`
	Doctype        bool                `json:"doctype"`
	Generator      string              `json:"generator,omitempty"`
	Favicon        string              `json:"favicon,omitempty"`
	AMP            string              `json:"amp,omitempty"`
	PrevURL        string              `json:"prev,omitempty"`
	NextURL        string              `json:"next,omitempty"`
	Hreflang       []Hreflang          `json:"hreflang,omitempty"`
	OpenGraph      map[string]string   `json:"openGraph,omitempty"`
	Twitter        map[string]string   `json:"twitter,omitempty"`
	Schema         []SchemaItem        `json:"schema,omitempty"`
	WordCount      int                 `json:"wordCount"`
	TextRatio      float64             `json:"textRatio"`
	Readability    float64             `json:"readability"`
	ReadingLevel   string              `json:"readingLevel,omitempty"`
	Sentences      int                 `json:"sentences"`
	Keywords       []Keyword           `json:"keywords,omitempty"`
	ContentHash    string              `json:"contentHash,omitempty"`
	Simhash        uint64              `json:"-"`
	TextSample     string              `json:"textSample,omitempty"`
	Links          []LinkRef           `json:"links,omitempty"`
	InternalLinks  int                 `json:"internalLinks"`
	ExternalLinks  int                 `json:"externalLinks"`
	NofollowLinks  int                 `json:"nofollowLinks"`
	Images         []ImageRef          `json:"images,omitempty"`
	Scripts        []string            `json:"scripts,omitempty"`
	Styles         []string            `json:"styles,omitempty"`
	RenderBlocking int                 `json:"renderBlocking"`
	InlineScriptKB int                 `json:"inlineScriptKb"`
	InlineStyleKB  int                 `json:"inlineStyleKb"`
	DOMNodes       int                 `json:"domNodes"`
	DOMDepth       int                 `json:"domDepth"`
	Iframes        int                 `json:"iframes"`
	Forms          int                 `json:"forms"`
	MixedContent   []string            `json:"mixedContent,omitempty"`
	Deprecated     []string            `json:"deprecated,omitempty"`
	A11y           A11y                `json:"a11y"`
	Inlinks        int                 `json:"inlinks"`
	UniqueInlinks  int                 `json:"uniqueInlinks"`
	LinkScore      float64             `json:"linkScore"`
	InSitemap      bool                `json:"inSitemap"`
	Issues         []string            `json:"issues,omitempty"`
	KeywordCheck   *KeywordCheck       `json:"keywordCheck,omitempty"`
	Custom         map[string]int      `json:"custom,omitempty"`    // custom search rule name -> matches
	Extracted      map[string][]string `json:"extracted,omitempty"` // extraction rule name -> values
	Retried        bool                `json:"retried,omitempty"`
	CrawledAt      time.Time           `json:"crawledAt"`
}

type A11y struct {
	EmptyLinks       int `json:"emptyLinks"`
	ButtonsNoName    int `json:"buttonsNoName"`
	InputsNoLabel    int `json:"inputsNoLabel"`
	ImagesNoAlt      int `json:"imagesNoAlt"`
	SkippedHeadings  int `json:"skippedHeadings"`
	DuplicateIDs     int `json:"duplicateIds"`
	IframesNoTitle   int `json:"iframesNoTitle"`
	GenericLinkTexts int `json:"genericLinkTexts"`
	PositiveTabindex int `json:"positiveTabindex"`
}

type KeywordCheck struct {
	Keyword     string `json:"keyword"`
	InTitle     bool   `json:"inTitle"`
	InDesc      bool   `json:"inDescription"`
	InH1        bool   `json:"inH1"`
	InURL       bool   `json:"inUrl"`
	InFirst100  bool   `json:"inFirst100"`
	Occurrences int    `json:"occurrences"`
}

// Resource is an image, script, stylesheet or external link target checked during the crawl.
type Resource struct {
	URL          string   `json:"url"`
	Kind         string   `json:"kind"` // image | script | style | external
	Status       int      `json:"status"`
	Error        string   `json:"error,omitempty"`
	ContentType  string   `json:"contentType,omitempty"`
	Size         int64    `json:"size"`
	CacheControl string   `json:"cacheControl,omitempty"`
	Compression  string   `json:"compression,omitempty"`
	RedirectTo   string   `json:"redirectTo,omitempty"`
	Internal     bool     `json:"internal"`
	TimeMs       int      `json:"timeMs"`
	FoundOn      []string `json:"foundOn"`
	Reverified   string   `json:"reverified,omitempty"` // result of the browser-UA re-check of a broken link
	FoundOnCount int      `json:"foundOnCount"`
}

// LinkEdge is one hyperlink between crawled URLs (internal) used for inlink reports.
type LinkEdge struct {
	From     string `json:"from"`
	To       string `json:"to"`
	Anchor   string `json:"anchor"`
	Nofollow bool   `json:"nofollow"`
}
