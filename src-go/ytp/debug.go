package main

// GET /api/debug?url=LINK shows, for each client and with or without the ad flag (pyv), what
// YouTube's player call answered: the status, whether the session counted as signed in, and how
// many formats came with an address. For finding out why a video resolves to nothing. It holds
// no secrets: no addresses, cookies or tokens are included.

import (
	"net/http"
	"sort"
)

func registerDebug(mux *http.ServeMux, cookies func() string) {
	mux.HandleFunc("/api/debug", func(w http.ResponseWriter, r *http.Request) {
		vid, err := videoID(r.URL.Query().Get("url"))
		if err != nil {
			sendJSON(w, 400, jmap{"error": err.Error()})
			return
		}
		cookie := cookies()
		pm, perr := playerInfo()
		out := jmap{"id": vid, "cookies": cookie != "", "player": pm.ID}
		if perr != nil {
			out["player_error"] = perr.Error()
		}
		var calls []jmap
		for _, c := range []struct {
			cl  string
			pyv bool
		}{{"mweb", true}, {"mweb", false}, {"tv", true}, {"tv", false}, {"ios", true}, {"android_vr", true}} {
			p := player(vid, c.cl, cookie, pm.STS, c.pyv)
			ps, sd := obj(p, "playabilityStatus"), obj(p, "streamingData")
			one := jmap{"client": c.cl, "pyv": c.pyv, "status": str(ps, "status"), "reason": str(ps, "reason")}
			for _, x := range arr(obj(p, "responseContext"), "serviceTrackingParams") {
				xm, _ := x.(jmap)
				for _, y := range arr(xm, "params") {
					if ym, _ := y.(jmap); str(ym, "key") == "logged_in" {
						one["logged_in"] = str(ym, "value") == "1"
					}
				}
			}
			withURL, withCipher, neither, drm := 0, 0, 0, 0
			var sample []string
			all := append(arr(sd, "formats"), arr(sd, "adaptiveFormats")...)
			for _, a := range all {
				f, _ := a.(jmap)
				switch {
				case f["drmFamilies"] != nil:
					drm++
				case str(f, "url") != "":
					withURL++
				case str(f, "signatureCipher") != "":
					withCipher++
				default:
					neither++
					if sample == nil {
						for k := range f {
							sample = append(sample, k)
						}
						sort.Strings(sample)
					}
				}
			}
			one["formats"] = jmap{"total": len(all), "with_url": withURL, "with_cipher": withCipher, "without_address": neither, "drm": drm}
			if sample != nil {
				one["fields_of_a_format_without_address"] = sample
			}
			var keys []string
			for k := range sd {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			one["streaming_data_fields"] = keys
			one["sabr_only"] = str(sd, "serverAbrStreamingUrl") != "" && withURL+withCipher == 0
			// What the resolver itself makes of this client (with its preview check).
			tm := &timing{m: jmap{}}
			info, status := func() (i *Info, s string) {
				defer func() {
					if rec := recover(); rec != nil {
						s = "panic"
					}
				}()
				return extract(vid, c.cl, cookie, tm, c.pyv, true)
			}()
			one["resolver"] = jmap{"usable": info != nil, "status": status, "timing": tm.copy()}
			calls = append(calls, one)
		}
		out["calls"] = calls
		sendJSON(w, 200, out)
	})
}
