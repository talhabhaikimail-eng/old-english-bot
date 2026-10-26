package main

import (
	"crypto/sha1"
	"encoding/hex"
	"hash/fnv"
	"math"
	"sort"
	"strings"
	"unicode"
)

func words(text string) []string {
	f := strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r) && r != '\'' && r != '-'
	})
	out := f[:0]
	for _, w := range f {
		w = strings.Trim(w, "'-")
		if w != "" && hasLetter(w) {
			out = append(out, w)
		}
	}
	return out
}

func countSentences(text string) int {
	n := 0
	prevEnd := false
	for _, r := range text {
		if r == '.' || r == '!' || r == '?' || r == '。' {
			if !prevEnd {
				n++
			}
			prevEnd = true
		} else if !unicode.IsSpace(r) {
			prevEnd = false
		}
	}
	if n == 0 && strings.TrimSpace(text) != "" {
		n = 1
	}
	return n
}

// syllables is the usual English vowel-group heuristic; good enough for a Flesch estimate.
func syllables(w string) int {
	w = strings.ToLower(w)
	if len(w) <= 3 {
		return 1
	}
	w = strings.TrimSuffix(w, "es")
	w = strings.TrimSuffix(w, "ed")
	if strings.HasSuffix(w, "e") && !strings.HasSuffix(w, "le") {
		w = w[:len(w)-1]
	}
	n := 0
	prevVowel := false
	for _, r := range w {
		v := strings.ContainsRune("aeiouy", r)
		if v && !prevVowel {
			n++
		}
		prevVowel = v
	}
	if n == 0 {
		return 1
	}
	return n
}

// fleschReadingEase returns the score (0–100, higher = easier) and a grade label.
func fleschReadingEase(ws []string, sentences int) (float64, string) {
	if len(ws) < 30 || sentences == 0 {
		return 0, ""
	}
	syl := 0
	for _, w := range ws {
		syl += syllables(w)
	}
	score := 206.835 - 1.015*(float64(len(ws))/float64(sentences)) - 84.6*(float64(syl)/float64(len(ws)))
	score = math.Max(0, math.Min(100, score))
	score = math.Round(score*10) / 10
	var label string
	switch {
	case score >= 90:
		label = "Very easy (5th grade)"
	case score >= 80:
		label = "Easy (6th grade)"
	case score >= 70:
		label = "Fairly easy (7th grade)"
	case score >= 60:
		label = "Plain English (8–9th grade)"
	case score >= 50:
		label = "Fairly difficult (10–12th grade)"
	case score >= 30:
		label = "Difficult (college)"
	default:
		label = "Very difficult (graduate)"
	}
	return score, label
}

var stopwords = func() map[string]bool {
	list := `a about above after again against all am an and any are aren't as at be because been before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves will just also may us get one new like use using used can't via per etc many much make made see well back even still way get got`
	m := map[string]bool{}
	for _, w := range strings.Fields(list) {
		m[w] = true
	}
	return m
}()

// topKeywords returns the most frequent single words and two-word phrases (stopwords removed).
func topKeywords(ws []string, n int) []Keyword {
	if len(ws) == 0 {
		return nil
	}
	counts := map[string]int{}
	for i, w := range ws {
		if len(w) < 3 || stopwords[w] {
			continue
		}
		counts[w]++
		if i+1 < len(ws) {
			nx := ws[i+1]
			if len(nx) >= 3 && !stopwords[nx] {
				counts[w+" "+nx]++
			}
		}
	}
	type kv struct {
		k string
		v int
	}
	var list []kv
	for k, v := range counts {
		if v >= 2 {
			list = append(list, kv{k, v})
		}
	}
	sort.Slice(list, func(i, j int) bool {
		// Phrases are weighted up slightly; they say more about a page than single words.
		wi := float64(list[i].v) * (1 + 0.5*float64(strings.Count(list[i].k, " ")))
		wj := float64(list[j].v) * (1 + 0.5*float64(strings.Count(list[j].k, " ")))
		if wi != wj {
			return wi > wj
		}
		return list[i].k < list[j].k
	})
	if len(list) > n {
		list = list[:n]
	}
	out := make([]Keyword, len(list))
	for i, e := range list {
		out[i] = Keyword{Term: e.k, Count: e.v, Density: math.Round(float64(e.v)/float64(len(ws))*10000) / 100}
	}
	return out
}

func contentHash(ws []string) string {
	h := sha1.Sum([]byte(strings.Join(ws, " ")))
	return hex.EncodeToString(h[:8])
}

// simhash over word 3-shingles; near-duplicate pages differ in only a few bits.
func simhash(ws []string) uint64 {
	if len(ws) < 3 {
		return 0
	}
	var v [64]int
	for i := 0; i+2 < len(ws); i++ {
		h := fnv.New64a()
		h.Write([]byte(ws[i] + " " + ws[i+1] + " " + ws[i+2]))
		x := h.Sum64()
		for b := 0; b < 64; b++ {
			if x&(1<<uint(b)) != 0 {
				v[b]++
			} else {
				v[b]--
			}
		}
	}
	var out uint64
	for b := 0; b < 64; b++ {
		if v[b] > 0 {
			out |= 1 << uint(b)
		}
	}
	return out
}

func hamming(a, b uint64) int {
	x := a ^ b
	n := 0
	for x != 0 {
		x &= x - 1
		n++
	}
	return n
}

// Approximate Arial widths (px at 20px for titles, 14px for descriptions) used by SERP-preview tools.
var narrow = "iljtf.,;:!|'I[]()1 "
var wide = "mwMW@%"

func pixelWidth(s string, fontPx float64) int {
	w := 0.0
	for _, r := range s {
		switch {
		case strings.ContainsRune(narrow, r):
			w += 0.28
		case strings.ContainsRune(wide, r):
			w += 0.86
		case unicode.IsUpper(r):
			w += 0.67
		case unicode.IsDigit(r):
			w += 0.56
		case r > 0x2E80:
			w += 1.0 // CJK
		default:
			w += 0.52
		}
	}
	return int(math.Round(w * fontPx))
}
