package main

import (
	"compress/gzip"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// AuditSummary is the light-weight listing entry kept in memory for every stored audit.
type AuditSummary struct {
	ID         string         `json:"id"`
	URL        string         `json:"url"`
	Host       string         `json:"host"`
	Status     string         `json:"status"`
	Error      string         `json:"error,omitempty"`
	Score      int            `json:"score"`
	Grade      string         `json:"grade"`
	Pages      int            `json:"pages"`
	Errors     int            `json:"errors"`
	Warnings   int            `json:"warnings"`
	Notices    int            `json:"notices"`
	CreatedAt  time.Time      `json:"createdAt"`
	FinishedAt time.Time      `json:"finishedAt"`
	DurationMs int64          `json:"durationMs"`
	Categories map[string]int `json:"categories,omitempty"`
	Progress   *Progress      `json:"progress,omitempty"`
	Options    Options        `json:"options"`
}

func summarize(r *Report) AuditSummary {
	opts := r.Options
	opts.PageSpeedKey = ""
	return AuditSummary{
		ID: r.ID, URL: r.StartURL, Host: r.Host, Status: r.Status, Error: r.Error, Score: r.Score, Grade: r.Grade,
		Pages: r.Summary.PagesCrawled, Errors: r.Summary.Errors, Warnings: r.Summary.Warnings, Notices: r.Summary.Notices,
		CreatedAt: r.CreatedAt, FinishedAt: r.FinishedAt, DurationMs: r.DurationMs, Categories: r.CategoryScores, Options: opts,
	}
}

type entry struct {
	summary AuditSummary
	audit   *Audit  // set while queued/running
	report  *Report // cached finished report (nil = on disk only)
	used    time.Time
}

type Store struct {
	mu         sync.Mutex
	dir        string
	entries    map[string]*entry
	maxStored  int
	maxRunning int
	running    int
	queue      []*Audit
}

func NewStore(dir string, maxStored, maxRunning int) *Store {
	s := &Store{dir: dir, entries: map[string]*entry{}, maxStored: maxStored, maxRunning: maxRunning}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("[store] cannot create %s: %v (audits will not persist)", dir, err)
		s.dir = ""
		return s
	}
	s.load()
	return s
}

func newID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return time.Now().UTC().Format("20060102-150405") + "-" + hex.EncodeToString(b)
}

func (s *Store) load() {
	files, _ := filepath.Glob(filepath.Join(s.dir, "*.json.gz"))
	for _, f := range files {
		r, err := readReport(f)
		if err != nil {
			log.Printf("[store] skipping %s: %v", filepath.Base(f), err)
			continue
		}
		if r.Status == "running" || r.Status == "queued" {
			r.Status = "failed"
			r.Error = "service restarted during the audit"
		}
		s.entries[r.ID] = &entry{summary: summarize(r)}
	}
	log.Printf("[store] loaded %d stored audits from %s", len(s.entries), s.dir)
}

func readReport(path string) (*Report, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return nil, err
	}
	defer gz.Close()
	var r Report
	if err := json.NewDecoder(gz).Decode(&r); err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *Store) path(id string) string { return filepath.Join(s.dir, id+".json.gz") }

func (s *Store) save(r *Report) {
	if s.dir == "" {
		return
	}
	tmp := s.path(r.ID) + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		log.Printf("[store] save %s: %v", r.ID, err)
		return
	}
	gz := gzip.NewWriter(f)
	saved := *r
	saved.Options.PageSpeedKey = ""
	err = json.NewEncoder(gz).Encode(&saved)
	if cerr := gz.Close(); err == nil {
		err = cerr
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp)
		log.Printf("[store] save %s: %v", r.ID, err)
		return
	}
	if err := os.Rename(tmp, s.path(r.ID)); err != nil {
		log.Printf("[store] rename %s: %v", r.ID, err)
	}
}

// Start queues a new audit and runs it when a slot is free.
func (s *Store) Start(opts Options) (*AuditSummary, error) {
	a, err := newAudit(newID(), opts)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	active := 0
	for _, e := range s.entries {
		if e.audit != nil {
			active++
		}
	}
	if active >= 10 {
		return nil, errors.New("too many audits queued — wait for one to finish")
	}
	sum := summarize(a.report)
	s.entries[a.report.ID] = &entry{summary: sum, audit: a, used: time.Now()}
	s.queue = append(s.queue, a)
	s.pumpLocked()
	return &sum, nil
}

func (s *Store) pumpLocked() {
	for s.running < s.maxRunning && len(s.queue) > 0 {
		a := s.queue[0]
		s.queue = s.queue[1:]
		if a.ctx.Err() != nil {
			s.finish(a, false)
			continue
		}
		s.running++
		go func(a *Audit) {
			r := a.Run()
			log.Printf("[audit %s] %s %s — %d pages, score %d (%s)", r.ID, r.StartURL, r.Status, r.Summary.PagesCrawled, r.Score, time.Duration(r.DurationMs)*time.Millisecond)
			s.finish(a, true)
		}(a)
	}
}

func (s *Store) finish(a *Audit, ran bool) {
	r := a.report
	if !ran {
		r.Status = "cancelled"
		r.Error = "cancelled before it started"
		r.Progress = a.Progress()
	}
	s.save(r)
	s.mu.Lock()
	defer s.mu.Unlock()
	if ran {
		s.running--
	}
	if e := s.entries[r.ID]; e != nil {
		e.audit = nil
		e.summary = summarize(r)
		e.report = r
		e.used = time.Now()
	}
	s.evictLocked()
	s.pumpLocked()
}

// evictLocked deletes the oldest finished audits beyond maxStored and drops cached reports
// beyond a small in-memory budget.
func (s *Store) evictLocked() {
	var done []*entry
	for _, e := range s.entries {
		if e.audit == nil {
			done = append(done, e)
		}
	}
	sort.Slice(done, func(i, j int) bool { return done[i].summary.CreatedAt.After(done[j].summary.CreatedAt) })
	for i, e := range done {
		if i >= s.maxStored {
			delete(s.entries, e.summary.ID)
			if s.dir != "" {
				os.Remove(s.path(e.summary.ID))
			}
		}
	}
	var cached []*entry
	for _, e := range s.entries {
		if e.report != nil && e.audit == nil {
			cached = append(cached, e)
		}
	}
	sort.Slice(cached, func(i, j int) bool { return cached[i].used.After(cached[j].used) })
	for i, e := range cached {
		if i >= 4 && s.dir != "" {
			e.report = nil
		}
	}
}

func (s *Store) List() []AuditSummary {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]AuditSummary, 0, len(s.entries))
	for _, e := range s.entries {
		sum := e.summary
		if e.audit != nil {
			p := e.audit.Progress()
			sum.Progress = &p
			sum.Status = "running"
			if p.Phase == "queued" {
				sum.Status = "queued"
			}
			sum.Pages = p.Crawled
		}
		out = append(out, sum)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out
}

var errNotFound = errors.New("audit not found")

// Get returns the running audit (if any) or the finished report, loading it from disk if needed.
func (s *Store) Get(id string) (*Audit, *Report, error) {
	if strings.ContainsAny(id, `/\.`) {
		return nil, nil, errNotFound
	}
	s.mu.Lock()
	e := s.entries[id]
	if e == nil {
		s.mu.Unlock()
		return nil, nil, errNotFound
	}
	e.used = time.Now()
	if e.audit != nil {
		a := e.audit
		s.mu.Unlock()
		return a, nil, nil
	}
	if e.report != nil {
		r := e.report
		s.mu.Unlock()
		return nil, r, nil
	}
	s.mu.Unlock()
	r, err := readReport(s.path(id))
	if err != nil {
		return nil, nil, err
	}
	s.mu.Lock()
	e.report = r
	s.evictLocked()
	s.mu.Unlock()
	return nil, r, nil
}

func (s *Store) Cancel(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entries[id]
	if e == nil {
		return errNotFound
	}
	if e.audit != nil {
		e.audit.cancel()
		for i, q := range s.queue {
			if q == e.audit {
				s.queue = append(s.queue[:i], s.queue[i+1:]...)
				go s.finish(q, false)
				break
			}
		}
	}
	return nil
}

func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entries[id]
	if e == nil {
		return errNotFound
	}
	if e.audit != nil {
		return errors.New("audit is still running — cancel it first")
	}
	delete(s.entries, id)
	if s.dir != "" {
		os.Remove(s.path(id))
	}
	return nil
}
