/**
 * @file ytp-docs.ts
 * @description The public YouTube downloader API's documentation, served at /api/ytp/docs and
 * shown in the dashboard's YouTube panel. `{{BASE}}` is replaced with the server's address.
 */

export const YTP_DOCS = `# YouTube downloader API

Base address: \`{{BASE}}\`

## Access

Every request needs a secret access key (dashboard → YouTube → API access → Generate key). Send it one of three ways:

| How | Example |
|---|---|
| Header | \`Authorization: Bearer YOUR_KEY\` |
| Header | \`X-API-Key: YOUR_KEY\` |
| In the address | \`?key=YOUR_KEY\` (handy for links opened in a browser) |

A wrong or missing key gets \`401 {"error":"Unauthorized"}\`. Keys can be deleted in the dashboard at any time.

Errors always come back as JSON with an \`error\` field and a matching HTTP status.

## Two ways to download

- **Direct** (\`/api/ytp/download\`, further down): one link that streams the file. Nothing is stored, it starts at once, and it works after a restart. Best for a download button on a site.
- **Jobs** (below): the server prepares the file first, then you fetch it. Exact size, resumable, a classic mp4, playlists and live recordings. The file is kept for three hours.

## Download jobs

A job runs in the background: start one, ask how it is doing, then fetch the finished file.

### 1. Start a job

\`POST {{BASE}}/api/ytp/jobs\` (GET works too)

Parameters, in the address or as a JSON body:

| Name | Meaning |
|---|---|
| \`url\` | **Required.** A YouTube link (watch, youtu.be, Shorts, live) or an 11-character video id. |
| \`height\` | Video up to this height with sound: \`144\`, \`240\`, \`360\`, \`480\`, \`720\`, \`1080\`, \`1440\`, \`2160\` (4K), \`4320\` (8K). If the video has no such height, the best one below it is used. Default \`1080\`. |
| \`audio\` | \`1\` for sound only, as M4A (AAC). Add \`ext=webm\` for Opus. |
| \`f\` | One exact stream instead: \`bv\` (best video, no sound), \`ba\` (best audio) or an itag number from \`/api/ytp/resolve\`. |
| \`minutes\` | For a **live stream**: record from now for this many minutes (up to 120). Use with \`height\` (up to 1080). |

Answer (\`202\`):

\`\`\`json
{
  "id": "k3x9a2m1q0",
  "status": "pending",
  "progress": 0,
  "message": "Job initialized",
  "quality": "1080p",
  "status_url": "{{BASE}}/api/ytp/jobs/k3x9a2m1q0",
  "file_url": null
}
\`\`\`

### 2. Follow it

\`GET {{BASE}}/api/ytp/jobs/ID\`

\`\`\`json
{
  "id": "k3x9a2m1q0",
  "status": "downloading",
  "progress": 64,
  "message": "Downloading… 64% · 38.2 MB/s",
  "title": "Video title",
  "quality": "1080p",
  "size": null,
  "file_url": null,
  "created_at": "2026-11-13T07:10:00.000Z",
  "expires_at": "2026-11-13T10:10:00.000Z"
}
\`\`\`

\`status\` is one of \`pending\`, \`downloading\`, \`completed\`, \`failed\`, \`cancelled\`. Ask once a second or so. When it is \`completed\`, \`size\` (bytes), \`title\` (the file's name) and \`file_url\` are filled in. When it is \`failed\`, \`error\` says why.

### 3. Fetch the file

\`GET {{BASE}}/api/ytp/files/ID\`

Sends the file with its real name. It supports \`Range\`, so interrupted downloads can be resumed (\`curl -C -\`). Files are kept for **three hours**, and may be removed sooner if newer downloads need the room (downloads share half of the server's free disk space; the oldest go first). A removed file answers \`404\`.

### Whole playlists

Give a job a playlist link and it starts **one job per video**:

\`POST {{BASE}}/api/ytp/jobs?url=https://www.youtube.com/playlist?list=LIST_ID&height=720\`

| Name | Meaning |
|---|---|
| \`url\` | A playlist link, or a bare playlist id. A link that has both a video and a list (\`watch?v=…&list=…\`) downloads only the video unless you add \`playlist=1\`. |
| \`height\`, \`audio\`, \`ext\`, \`f\` | As for a single video; applied to every video. A video without that height gets the best one below it. |
| \`start\`, \`limit\` | Start at this position (from 1) and take at most this many videos (up to 500 per call). |

Answer (\`202\`):

\`\`\`json
{
  "playlist": { "id": "LIST_ID", "title": "…", "count": 42, "queued": 42 },
  "jobs": [ { "id": "…", "status": "pending", "title": "…", "status_url": "…", "file_url": null } ]
}
\`\`\`

Two downloads run at a time; the rest wait with \`"status":"pending"\`. If \`queued\` is lower than \`count\` (or than your \`limit\`), the disk share was full: fetch and delete finished files, then start the rest with \`start=\`. Fetch files as they finish; with a long playlist the oldest ones are removed to make room for the newest.

To only look at a playlist: \`GET {{BASE}}/api/ytp/playlist?url=LINK\` →

\`\`\`json
{ "id": "LIST_ID", "title": "…", "url": "…", "count": 42,
  "videos": [ { "id": "VIDEO_ID", "url": "https://www.youtube.com/watch?v=VIDEO_ID", "title": "…",
                "author": "…", "duration": 254, "thumbnail": "…" } ] }
\`\`\`

Private playlists, Liked videos (\`LL\`) and Watch later (\`WL\`) work for the signed-in account. At most 2000 videos are listed.

### Other job calls

| Call | What it does |
|---|---|
| \`GET {{BASE}}/api/ytp/jobs\` | All current jobs, newest first, with the storage in use. |
| \`DELETE {{BASE}}/api/ytp/jobs/ID\` | Cancel a job that is waiting or running (it stays listed as \`cancelled\`). On a job that has ended: remove it and its file. |

### Example: shell

\`\`\`bash
KEY=YOUR_KEY
BASE={{BASE}}

# start
ID=$(curl -s -X POST -H "Authorization: Bearer $KEY" \\
  "$BASE/api/ytp/jobs?url=https://youtu.be/VIDEO_ID&height=2160" | jq -r .id)

# wait
while :; do
  S=$(curl -s -H "Authorization: Bearer $KEY" "$BASE/api/ytp/jobs/$ID")
  echo "$S" | jq -r '"\\(.status) \\(.progress)% \\(.message)"'
  case $(echo "$S" | jq -r .status) in completed) break;; failed) exit 1;; esac
  sleep 2
done

# fetch, under the video's own name
curl -L -OJ -H "Authorization: Bearer $KEY" "$BASE/api/ytp/files/$ID"
\`\`\`

### Example: JavaScript

\`\`\`js
const BASE = '{{BASE}}', KEY = 'YOUR_KEY';
const call = (path, init) =>
  fetch(BASE + path, { ...init, headers: { Authorization: 'Bearer ' + KEY } }).then(r => r.json());

let job = await call('/api/ytp/jobs?url=https://youtu.be/VIDEO_ID&audio=1', { method: 'POST' });
while (job.status === 'pending' || job.status === 'downloading') {
  await new Promise(r => setTimeout(r, 1500));
  job = await call('/api/ytp/jobs/' + job.id);
}
if (job.status === 'failed') throw new Error(job.error);
console.log('ready:', job.file_url + '?key=' + KEY);
\`\`\`

### Example: Python

\`\`\`python
import requests, time
BASE, KEY = "{{BASE}}", "YOUR_KEY"
H = {"Authorization": f"Bearer {KEY}"}

job = requests.post(f"{BASE}/api/ytp/jobs", headers=H,
                    json={"url": "https://youtu.be/VIDEO_ID", "height": 1080}).json()
while job["status"] in ("pending", "downloading"):
    time.sleep(1.5)
    job = requests.get(f"{BASE}/api/ytp/jobs/{job['id']}", headers=H).json()
if job["status"] == "failed":
    raise SystemExit(job["error"])
with requests.get(job["file_url"], headers=H, stream=True) as r, open(job["title"], "wb") as f:
    for chunk in r.iter_content(1 << 20):
        f.write(chunk)
\`\`\`

## Looking things up

### Search

\`GET {{BASE}}/api/ytp/search?q=WORDS&limit=20\` (limit up to 50)

\`\`\`json
{ "results": [ { "videoId": "…", "url": "https://youtube.com/watch?v=…", "title": "…",
  "thumbnail": "…", "duration": "4:14", "durationSeconds": 254, "views": 1234567,
  "ago": "2 years ago", "author": "Channel" } ] }
\`\`\`

### What a video offers

\`GET {{BASE}}/api/ytp/info?url=LINK\`

\`\`\`json
{
  "id": "VIDEO_ID", "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "title": "…", "author": "Channel name", "duration": 314, "live": false,
  "channel_id": "UC…", "channel_url": "https://www.youtube.com/channel/UC…",
  "description": "The full description…", "views": 335574252,
  "published": "2018-06-12T19:49:29-07:00", "category": "Film & Animation",
  "keywords": ["4K", "…"], "family_safe": true,
  "thumbnail": "https://i.ytimg.com/vi/VIDEO_ID/hqdefault.jpg",
  "thumbnails": [ { "url": "…", "width": 1920, "height": 1080 } ],
  "video": [ { "height": 2160, "fps": 60, "codec": "vp9", "ext": "webm", "size": 1138500000 },
             { "height": 1080, "fps": 60, "codec": "avc1.64002A", "ext": "mp4", "size": 171000000 } ],
  "audio": [ { "ext": "m4a", "codec": "mp4a.40.2", "kbps": 130, "size": 5080048 },
             { "ext": "webm", "codec": "opus", "kbps": 148, "size": 5199989 } ]
}
\`\`\`

\`duration\` is in seconds. \`thumbnail\` is always there; \`thumbnails\` lists the sizes YouTube has, smallest first. \`description\`, \`views\`, \`published\`, \`category\`, \`keywords\` and \`family_safe\` come from the video's page and are left out when YouTube does not give them (treat them as optional). Like counts and comments are not included.

Each \`video\` entry is what \`height=…\` would give you: \`size\` is the finished file (picture and sound), \`ext\` its container. Up to 1080p is H.264 in \`.mp4\`; above that YouTube only has VP9 or AV1, so the file is \`.webm\` or \`.mkv\`. For a live stream \`live\` is \`true\` and sizes are \`0\`.

### Raw streams

\`GET {{BASE}}/api/ytp/resolve?url=LINK\` lists every stream YouTube offers (itag, codec, bitrate, size) with a \`src\` path. \`GET {{BASE}}/api/ytp\` + that \`src\` + \`?range=START-END\` reads bytes of one stream, at most 10 MiB per request.

### Is it working

\`GET {{BASE}}/api/ytp/health\` → \`{"ok":true,"cookies":true}\`. \`cookies\` is whether the server has a signed-in YouTube session; without one YouTube refuses most requests from a server.

## Direct downloads: one link, nothing stored

\`GET {{BASE}}/api/ytp/download?url=LINK&…\` takes the same options as a job (\`height\`, \`audio\`, \`ext\`, \`f\`) and answers with the file itself. The bytes go from YouTube through the server to the caller as they arrive: nothing is written to the server's disk, the first bytes arrive within seconds whatever the size, and the link keeps working after a server restart, because it holds only the video and the choice. This is the one to put behind a "Download" button.

| Request | What you get |
|---|---|
| \`audio=1\`, or \`f=…\` (one stream) | The exact size (\`Content-Length\`) and \`Range\` support: a browser shows the time left, and an interrupted download can be resumed, even days later. |
| \`height=…\` (picture and sound joined) | Joined on the fly. The size is not known in advance (no \`Content-Length\`; \`X-Estimated-Size\` gives it to within a percent or so) and it cannot be resumed. \`.mp4\` comes "fragmented", which browsers, phones, VLC and editors read; a few old TVs and players do not. Need the exact size, resuming, or a classic mp4? Use a job. |

A direct download holds a connection for as long as the caller takes to receive it. Add \`&id=ANY_NAME\` to follow one with \`GET {{BASE}}/api/ytp/progress?id=ANY_NAME\` → \`{"stage":"downloading","done":123,"total":456}\`.

Live streams cannot be sent this way: record them with a job (\`minutes=…\`). \`GET {{BASE}}/api/ytp/record?…\` exists but answers only when the recording is finished, which runs into the 100-second limit for anything but a minute or so.

## Good to know

- Everything is fetched with the server owner's YouTube account. Heavy use can get that account limited, so keep keys private.
- There is no rate limit; be reasonable.
- All keys see all jobs.
- The server restarts every few hours. Jobs and files do not survive a restart: a job that vanishes (\`404\`) has to be started again.
- Age-restricted and members-only videos work only if the signed-in account may watch them. DRM-protected videos (rentals, some music) cannot be downloaded.
- A live recording starts at the moment the job starts; it cannot go back in time.
`;
