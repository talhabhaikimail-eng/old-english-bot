package main

// Playlists: GET /api/playlist?url=LINK_OR_ID lists a playlist's videos, read from YouTube's own
// page API (the "browse" call the website makes), following its "load more" markers.

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	browseAPI = origin + "/youtubei/v1/browse?prettyPrint=false"
	webUA     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
	webVer    = "2.20251105.01.00"
	// The most videos one listing returns.
	playlistLimit = 2000
)

var listRe = regexp.MustCompile(`(?:[?&]list=|^)((?:PL|UU|LL|FL|RD|OL|WL)[\w-]{2,}|[\w-]{13,})`)

// playlistID finds a playlist id in a link, or accepts a bare id.
func playlistID(s string) (string, error) {
	if m := listRe.FindStringSubmatch(s); m != nil {
		return m[1], nil
	}
	return "", errors.New("no playlist id in " + strconv.Quote(s))
}

type playlistVideo struct {
	ID       string `json:"id"`
	URL      string `json:"url"`
	Title    string `json:"title"`
	Author   string `json:"author"`
	Duration int    `json:"duration"`
	Thumb    string `json:"thumbnail"`
}

// browse asks YouTube's page API for a playlist page (browseId) or the next one (continuation).
func browse(body jmap, cookie string) (jmap, error) {
	body["context"] = jmap{"client": jmap{"clientName": "WEB", "clientVersion": webVer, "hl": "en", "gl": "US"}}
	h := map[string]string{"Content-Type": "application/json", "User-Agent": webUA, "Origin": origin,
		"X-YouTube-Client-Name": "1", "X-YouTube-Client-Version": webVer}
	if cookie != "" {
		// Signed in: private and "unlisted" playlists of the account, Liked videos, Watch later.
		h["Cookie"] = cookie
		h["Authorization"] = sapisidAuth(cookie)
		h["X-Origin"] = origin
		h["X-Goog-AuthUser"] = "0"
	}
	b, _ := json.Marshal(body)
	out, err := fetch("POST", browseAPI, b, h, 20*time.Second)
	if err != nil {
		return nil, err
	}
	var p jmap
	if err := json.Unmarshal(out, &p); err != nil {
		return nil, errors.New("YouTube's answer was not JSON")
	}
	return p, nil
}

// textOf reads YouTube's two text shapes: {"simpleText": …} and {"runs": [{"text": …}]}.
func textOf(v any) string {
	m, _ := v.(jmap)
	if m == nil {
		return ""
	}
	if s := str(m, "simpleText"); s != "" {
		return s
	}
	out := ""
	for _, r := range arr(m, "runs") {
		if rm, ok := r.(jmap); ok {
			out += str(rm, "text")
		}
	}
	return out
}

// walk visits every object in a JSON tree, with the key it sits under.
func walk(v any, key string, visit func(key string, m jmap)) {
	switch t := v.(type) {
	case jmap:
		visit(key, t)
		for k, c := range t {
			walk(c, k, visit)
		}
	case []any:
		for _, c := range t {
			walk(c, key, visit)
		}
	}
}

// lists visits every array in a JSON tree.
func lists(v any, visit func([]any)) {
	switch t := v.(type) {
	case jmap:
		for _, c := range t {
			lists(c, visit)
		}
	case []any:
		visit(t)
		for _, c := range t {
			lists(c, visit)
		}
	}
}

// clock reads "2:53:49" or "4:14" as seconds.
func clock(s string) int {
	total := 0
	for _, part := range strings.Split(s, ":") {
		n, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil {
			return 0
		}
		total = total*60 + n
	}
	return total
}

// entry reads one element of a playlist's list: YouTube's current shape (lockupViewModel) or
// the older one (playlistVideoRenderer). ok is false for anything else.
func entry(e any) (playlistVideo, bool) {
	m, _ := e.(jmap)
	if old := obj(m, "playlistVideoRenderer"); old != nil {
		vid := str(old, "videoId")
		if vid == "" || old["isPlayable"] == false {
			return playlistVideo{}, false
		}
		secs, _ := strconv.Atoi(str(old, "lengthSeconds"))
		return playlistVideo{ID: vid, Title: textOf(old["title"]), Author: textOf(old["shortBylineText"]), Duration: secs}, true
	}
	l := obj(m, "lockupViewModel")
	vid := str(l, "contentId")
	if len(vid) != 11 || (str(l, "contentType") != "" && str(l, "contentType") != "LOCKUP_CONTENT_TYPE_VIDEO") {
		return playlistVideo{}, false
	}
	meta := obj(obj(l, "metadata"), "lockupMetadataViewModel")
	v := playlistVideo{ID: vid, Title: str(obj(meta, "title"), "content")}
	walk(meta["metadata"], "", func(key string, part jmap) {
		if key == "text" && v.Author == "" {
			v.Author = str(part, "content")
		}
	})
	walk(l["contentImage"], "", func(key string, badge jmap) {
		if key == "thumbnailBadgeViewModel" && v.Duration == 0 {
			v.Duration = clock(str(badge, "text"))
		}
	})
	return v, v.Title != ""
}

// listPlaylist returns a playlist's title and videos, in order.
func listPlaylist(id, cookie string) (string, []playlistVideo, error) {
	page, err := browse(jmap{"browseId": "VL" + id}, cookie)
	if err != nil {
		return "", nil, err
	}
	title := ""
	walk(page, "", func(key string, m jmap) {
		if key == "playlistMetadataRenderer" && title == "" {
			title = str(m, "title")
		}
	})
	var videos []playlistVideo
	seen := map[string]bool{}
	for pages := 0; page != nil && pages < 60; pages++ {
		next, added := "", 0
		// The videos sit in one array, in order, with the "load more" marker as its last element.
		lists(page, func(items []any) {
			here := 0
			for _, e := range items {
				if v, ok := entry(e); ok && !seen[v.ID] {
					seen[v.ID] = true
					v.URL = origin + "/watch?v=" + v.ID
					v.Thumb = "https://i.ytimg.com/vi/" + v.ID + "/mqdefault.jpg"
					videos = append(videos, v)
					here++
				}
			}
			if here == 0 {
				return
			}
			added += here
			walk(items[len(items)-1], "", func(key string, m jmap) {
				if key == "continuationCommand" {
					if t := str(m, "token"); t != "" {
						next = t
					}
				}
			})
		})
		if next == "" || added == 0 || len(videos) >= playlistLimit {
			break
		}
		if page, err = browse(jmap{"continuation": next}, cookie); err != nil {
			break // keep what was read
		}
	}
	if len(videos) == 0 {
		return title, nil, errors.New("the playlist is empty, private, or does not exist")
	}
	return title, videos, nil
}

func registerPlaylist(mux *http.ServeMux, cookies func() string) {
	mux.HandleFunc("/api/playlist", func(w http.ResponseWriter, r *http.Request) {
		id, err := playlistID(r.URL.Query().Get("url"))
		if err != nil {
			sendJSON(w, 400, jmap{"error": err.Error()})
			return
		}
		title, videos, err := listPlaylist(id, cookies())
		if err != nil {
			sendJSON(w, 502, jmap{"error": err.Error()})
			return
		}
		sendJSON(w, 200, jmap{"id": id, "title": title, "url": origin + "/playlist?list=" + id, "count": len(videos), "videos": videos})
	})
}
