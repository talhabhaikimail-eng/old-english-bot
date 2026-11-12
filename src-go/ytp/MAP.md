# How a YouTube link becomes a stream URL (measured 2026-11-11, over VPN)

```
link ──regex──> videoId (11 chars)
   │
   ├─(parallel)─ A) IOS client  POST /youtubei/v1/player   no cookies   ~0.8-1.0s
   │                 → plain URLs, ready to fetch. Public videos only (ignores cookies).
   │
   └─(parallel)─ B) TV (Samsung) client + cookies POST /youtubei/v1/player   ~0.7-1.3s
                     → logged in: age-restricted / account-gated OK, NO PO token
                     → URLs need: n=<challenge> solved, and s=<sig> solved if signatureCipher
                     → n/sig solver (yt-dlp EJS) on cached player   ~10 ms in-process, ~0.3s as CLI subprocess
   │
   ▼  pick A if OK, else B
https://rrN---sn-XXXX.googlevideo.com/videoplayback?...&n=<solved>[&sig=<solved>]
   GET &range=a-b (10 MiB chunks)   URL bound to requesting IP, expires ~6h
   if node unreachable → same URL on each node in mn= (+ &fallback_count=i)
```

Measured end-to-end (Python CLI incl. startup): public ~1.3s, gated ~1.8-2.0s.
Port with a persistent JS runtime: gated ≈ player request + ~10 ms.

## 1. Video id
`(?:v=|/shorts/|/live/|/embed/|youtu\.be/|/v/)([\w-]{11})`

## 2. Player version (cache ~6h)
- `GET https://www.youtube.com/iframe_api` (1 KB) → `player\/<8 hex id>\/`
- `GET /s/player/<id>/tv-player-ias.vflset/tv-player-ias.js` (2.5 MB, once per id)
- `sts` = `(?:signatureTimestamp|sts)\s*:\s*(\d{5})` in that file

## 3. Player request
`POST https://www.youtube.com/youtubei/v1/player?prettyPrint=false`
```json
{"context":{"client":{ ...client fields..., "hl":"en","gl":"US"}},
 "videoId":"ID","contentCheckOk":true,"racyCheckOk":true,
 "playbackContext":{"contentPlaybackContext":{"html5Preference":"HTML5_PREF_WANTS","signatureTimestamp":STS}}}
```
Headers: `Content-Type: application/json`, `User-Agent`, `Origin: https://www.youtube.com`,
`X-YouTube-Client-Name`, `X-YouTube-Client-Version`.
TV + cookies also: `Cookie`, `Authorization`, `X-Origin: https://www.youtube.com`, `X-Goog-AuthUser: 0`.

| client | id | clientName / version | extra fields | User-Agent |
|---|---|---|---|---|
| ios | 5 | IOS / 20.45.1 | deviceMake Apple, deviceModel iPhone16,2, osName iPhone, osVersion 18.6.2.22G100 | `com.google.ios.youtube/20.45.1 (iPhone16,2; U; CPU iOS 18_6_2 like Mac OS X;)` |
| tv | 7 | TVHTML5 / 5.20260707 | deviceMake Samsung, deviceModel UKS9800, osName Tizen, osVersion 2.4.0 | `Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1` |

iOS: send NO cookie+auth together (HTTP 400). No playbackContext needed.

### Authorization (cookie session)
```
ts = unix seconds
SAPISIDHASH   ts_ sha1(ts + " " + SAPISID           + " https://www.youtube.com")
SAPISID1PHASH ts_ sha1(ts + " " + __Secure-1PAPISID + " https://www.youtube.com")
SAPISID3PHASH ts_ sha1(ts + " " + __Secure-3PAPISID + " https://www.youtube.com")
Authorization: "SAPISIDHASH <..> SAPISID1PHASH <..> SAPISID3PHASH <..>"
```
Check `responseContext.serviceTrackingParams[].params[key=logged_in] == "1"`.

### Ad gate (important for logged-in, non-Premium cookies)
If the response has `adPlacements` (pre-roll, `AD_PLACEMENT_KIND_START`), every content URL returns
**403 for ~2.5 s** after issuance, then 200. Fix: add to the TV request
`playbackContext.adPlaybackContext = {"pyv": true}` → no adPlacements, URLs valid immediately.

### Age-restricted + pyv = 60 s preview (measured 2026-11-12)
On age-restricted videos, `pyv: true` makes YouTube return **preview-only URLs**: the first ~60 s of media
work, every byte range past that is 403 (all clients, any range style, pings/waiting don't help).
Nothing in the player response marks it (`ctier=L` is on public URLs too). Without `pyv` those URLs are
full and live at once (age-restricted videos have no ad gate); public videos still need `pyv` (else ~3 s gate).
Fix in `extract()`: after solving, probe the last 1 KiB of the smallest stream (~20-100 ms); 403 → redo the
TV request without `pyv` (+~0.9 s, gated videos only). PO tokens (bgutil, any binding) did NOT help.

### Previews and the ad gate, revisited (sweep of ~150 real videos, 2026-11-12)
- **ios also hands out previews**, on many monetized public videos (Despacito, MrBeast, ...): sometimes
  every stream, sometimes only >=720p (480p and below full, all HD cut at ~60 s). Rick Astley's 4K was full.
- tv + pyv gives a preview on those same videos, not only age-restricted ones; tv without pyv is full but
  ad-gated: **~3.3-3.9 s** of 403 on every range from issuance. Stats pings (videostatsPlaybackUrl/
  watchtime) don't lift it; tv without cookies gets the bot check. So these videos cost ~4 s in the CLI;
  apps should use the no-probe flag (play the preview, swap to the full URLs when the re-resolve lands).
- Probe = first + last KiB of the streams a player picks (best video, best audio), not the smallest one.
  A timed-out probe is retried, then counted as full (not as a refusal).
- **Live**: neither ios nor tv returns `hlsManifestUrl` any more (ios has a SABR `serverAbrStreamingUrl`).
  The adaptive URLs serve the newest segment as-is, or `&sq=N` (`X-Head-Seqnum` header = newest N),
  `targetDurationSec` per segment. tv + pyv: live segments are 403 for good -> live never uses pyv.
- tv `videoDetails` has no title/author: taken from the ios response, else `/oembed`.
- Dubbed videos list one audio track per language (`audioTrack.audioIsDefault` marks the original,
  `xtags=acont=original`); "best audio" must prefer it or you get e.g. the Arabic dub.

### IP reputation
Datacenter/VPN IPs get `LOGIN_REQUIRED "Sign in to confirm you're not a bot"` on IOS. The cookie (TV) path
passes it. Stream URLs are bound to the requesting IP (`ip=`), so resolve and play from the same network.

## 4. Formats
`streamingData.formats[]` (muxed) + `adaptiveFormats[]` (video-only / audio-only).
Each has `itag, mimeType (codecs), bitrate, height, fps, contentLength, url | signatureCipher`.
Skip entries with `drmFamilies`. `signatureCipher` is a query string: `url`, `s` (challenge), `sp` (param name, usually `sig`).

## 5. n / sig solving (TV path only)
Uses yt-dlp EJS (`ejs/lib.min.js` 150 KB + `ejs/core.min.js` 7 KB, Unlicense):
```js
// first time per player id:
jsc({type:"player", player:<tv-player-ias.js text>, output_preprocessed:true,
     requests:[{type:"n",challenges:[...]},{type:"sig",challenges:[...]}]})
// → {responses:[{type:"result",data:{challenge:answer}}...], preprocessed_player:"..."}  (cache it, ~3.5 MB)
// afterwards:
jsc({type:"preprocessed", preprocessed_player:<cached>, requests:[...]})
```
Then: replace `n=` value with answer; append `&<sp>=<answer>` for ciphered formats (URL-encode).
Unsolved n → HTTP 403. Solved n → 200 or 302 to the cache node.

## 6. Download
`GET <url>&range=START-END` in ~10 MiB chunks (no throttling, resumable). Same User-Agent as the client.
On connect failure rotate host `rrN---<node>` through `mn=` list, adding `&fallback_count=i`.

## Dead ends (don't bother)
| client | result |
|---|---|
| WEB / WEB_SAFARI / MWEB + cookies | logged in, but SABR-only / HLS segments 403 → need PO token (BotGuard, browser) |
| TVHTML5 7.x (Cobalt UA) | "The page needs to be reloaded" |
| WEB_EMBEDDED_PLAYER (iframe) | "This video is unavailable" via API; in browser uses SABR protobuf, no plain URLs |
| ANDROID | ignores cookies, only itag 18 |
| VISIONOS | plain URLs w/o JS but rejects cookies (HTTP 400) — possible 2nd public fallback |

## Go / Rust port
- Everything except step 5 is HTTP + JSON + SHA1 + regex.
- Step 5: embed a JS engine and keep it **alive** with the preprocessed player loaded:
  Rust `rquickjs` (QuickJS) or `boa_engine`; Go `github.com/dop251/goja` or a QuickJS binding.
  Load `lib.min.js`, `var meriyah=lib.meriyah,astring=lib.astring;`, `core.min.js`, then call `jsc(input)`.
  Preprocessing runs once per player id (~0.6s node; expect a few s on QuickJS/phone) — do it at app start or on player change.
- Run IOS and TV requests concurrently; prefer IOS when OK.
- Client versions drift: if a client starts failing, bump versions from yt-dlp `yt_dlp/extractor/youtube/_base.py`.
