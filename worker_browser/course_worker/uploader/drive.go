package uploader

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"course-worker/config"
	"course-worker/model"

	_ "github.com/lib/pq"
)

var (
	ErrTokenRefreshFailed = errors.New("failed to refresh Google Drive access token")
	ErrFolderCreateFailed = errors.New("failed to create Google Drive course folder")
	ErrUploadFailed       = errors.New("failed to upload file to Google Drive")
)

type DriveUploader struct {
	cfg            *config.Config
	httpClient     *http.Client
	mu             sync.Mutex
	cachedToken    string
	cachedRefresh  string
	tokenExpiry    time.Time
	defaultFolder  string
	cachedAccountID string
}

func NewDriveUploader(cfg *config.Config) *DriveUploader {
	return &DriveUploader{
		cfg: cfg,
		httpClient: &http.Client{
			Timeout: 0, // Individual requests use context deadlines
		},
		defaultFolder: cfg.DefaultDriveFolderID,
	}
}

// GetValidAccessToken returns an active Google Drive OAuth2 access token.
// Checks payload credentials first, then cached token, and automatically
// refreshes from Neon PostgreSQL database using GOOGLE_CLIENT_ID and CLIENT_SECRET.
func (u *DriveUploader) GetValidAccessToken(ctx context.Context, driveCfg *model.DriveUploadConfig) (string, string, error) {
	u.mu.Lock()
	defer u.mu.Unlock()

	// 1. If access token provided in payload and not expired, use it
	if driveCfg != nil && driveCfg.AccessToken != "" {
		parent := driveCfg.ParentFolderId
		if parent == "" {
			parent = u.defaultFolder
		}
		return driveCfg.AccessToken, parent, nil
	}

	// 2. Check cached token validity (buffer 2 minutes)
	if u.cachedToken != "" && time.Now().Add(2*time.Minute).Before(u.tokenExpiry) {
		return u.cachedToken, u.defaultFolder, nil
	}

	// 3. If refresh token is available, refresh it
	if u.cachedRefresh != "" {
		newToken, expiry, err := u.refreshOAuthToken(ctx, u.cachedRefresh)
		if err == nil {
			u.cachedToken = newToken
			u.tokenExpiry = expiry
			log.Printf("🔑 [Drive] Successfully refreshed Google Drive access token via OAuth")
			return u.cachedToken, u.defaultFolder, nil
		}
		log.Printf("⚠️ [Drive] Cached refresh token failed (%v), querying database for fresh account...", err)
	}

	// 4. Query Neon PostgreSQL database for active Google Drive account
	if u.cfg.DatabaseURL != "" {
		accID, email, refreshTok, accessTok, folderID, err := u.fetchAccountFromDB(ctx)
		if err == nil && refreshTok != "" {
			u.cachedRefresh = refreshTok
			u.cachedAccountID = accID
			if folderID != "" {
				u.defaultFolder = folderID
			}

			// Refresh token with Google OAuth
			newToken, expiry, err := u.refreshOAuthToken(ctx, refreshTok)
			if err == nil {
				u.cachedToken = newToken
				u.tokenExpiry = expiry
				log.Printf("🔑 [Drive] Obtained fresh access token for account %s (%s)", email, accID)
				return u.cachedToken, u.defaultFolder, nil
			} else if accessTok != "" {
				// Fallback to database access token
				u.cachedToken = accessTok
				u.tokenExpiry = time.Now().Add(15 * time.Minute)
				log.Printf("ℹ️ [Drive] Using existing access token from DB for %s", email)
				return u.cachedToken, u.defaultFolder, nil
			}
		} else {
			log.Printf("⚠️ [Drive] Failed to fetch account from database: %v", err)
		}
	}

	return "", "", ErrTokenRefreshFailed
}

func (u *DriveUploader) fetchAccountFromDB(ctx context.Context) (accID, email, refreshTok, accessTok, folderID string, err error) {
	db, err := sql.Open("postgres", u.cfg.DatabaseURL)
	if err != nil {
		return "", "", "", "", "", fmt.Errorf("db open error: %w", err)
	}
	defer db.Close()

	queryCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()

	var tokensJSON string
	err = db.QueryRowContext(queryCtx,
		"SELECT id, email, tokens_json, default_folder_id FROM accounts WHERE is_active=true ORDER BY updated_at DESC LIMIT 1",
	).Scan(&accID, &email, &tokensJSON, &folderID)
	if err != nil {
		return "", "", "", "", "", fmt.Errorf("account query error: %w", err)
	}

	var parsed struct {
		RefreshToken string `json:"refresh_token"`
		AccessToken  string `json:"access_token"`
	}
	if err := json.Unmarshal([]byte(tokensJSON), &parsed); err == nil {
		refreshTok = parsed.RefreshToken
		accessTok = parsed.AccessToken
	}

	return accID, email, refreshTok, accessTok, folderID, nil
}

func (u *DriveUploader) refreshOAuthToken(ctx context.Context, refreshToken string) (string, time.Time, error) {
	if u.cfg.GoogleClientID == "" || u.cfg.ClientSecret == "" {
		return "", time.Time{}, errors.New("missing GOOGLE_CLIENT_ID or CLIENT_SECRET")
	}

	form := url.Values{
		"client_id":     {u.cfg.GoogleClientID},
		"client_secret": {u.cfg.ClientSecret},
		"refresh_token": {refreshToken},
		"grant_type":    {"refresh_token"},
	}

	reqCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, "POST", "https://oauth2.googleapis.com/token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", time.Time{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := u.httpClient.Do(req)
	if err != nil {
		return "", time.Time{}, err
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", time.Time{}, fmt.Errorf("oauth error %d: %s", resp.StatusCode, string(bodyBytes))
	}

	var res struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(bodyBytes, &res); err != nil {
		return "", time.Time{}, err
	}
	if res.AccessToken == "" {
		return "", time.Time{}, errors.New("empty access token returned by Google OAuth")
	}

	expiry := time.Now().Add(time.Duration(res.ExpiresIn-60) * time.Second)
	return res.AccessToken, expiry, nil
}

// InvalidateToken forces refresh on next token request (e.g. after HTTP 401).
func (u *DriveUploader) InvalidateToken() {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.cachedToken = ""
}

// EscapeDriveQuery escapes characters for Google Drive v3 file queries.
func EscapeDriveQuery(s string) string {
	s = strings.ReplaceAll(s, "\\", "\\\\")
	s = strings.ReplaceAll(s, "'", "\\'")
	return s
}

// EnsureSubfolder finds or creates a subfolder idempotently under parentFolderID.
func (u *DriveUploader) EnsureSubfolder(ctx context.Context, token, parentID, folderName string) (string, error) {
	cleanName := strings.TrimSpace(folderName)
	if cleanName == "" {
		cleanName = "Course Upload"
	}

	safeName := EscapeDriveQuery(cleanName)
	q := fmt.Sprintf("mimeType = 'application/vnd.google-apps.folder' and name = '%s' and trashed = false", safeName)
	if parentID != "" {
		q += fmt.Sprintf(" and '%s' in parents", parentID)
	}

	searchURL := fmt.Sprintf("https://www.googleapis.com/drive/v3/files?q=%s&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true", url.QueryEscape(q))

	// Try search first with retries
	for attempt := 1; attempt <= 3; attempt++ {
		req, _ := http.NewRequestWithContext(ctx, "GET", searchURL, nil)
		req.Header.Set("Authorization", "Bearer "+token)

		resp, err := u.httpClient.Do(req)
		if err == nil && resp.StatusCode == http.StatusOK {
			var searchRes struct {
				Files []struct {
					ID   string `json:"id"`
					Name string `json:"name"`
				} `json:"files"`
			}
			_ = json.NewDecoder(resp.Body).Decode(&searchRes)
			resp.Body.Close()

			if len(searchRes.Files) > 0 {
				log.Printf("📁 [Drive] Found existing course folder '%s' (ID: %s)", cleanName, searchRes.Files[0].ID)
				return searchRes.Files[0].ID, nil
			}
			break
		}
		if resp != nil {
			resp.Body.Close()
		}
		time.Sleep(time.Duration(attempt) * 500 * time.Millisecond)
	}

	// Create new folder
	createURL := "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true"
	payload := map[string]interface{}{
		"name":     cleanName,
		"mimeType": "application/vnd.google-apps.folder",
	}
	if parentID != "" {
		payload["parents"] = []string{parentID}
	}
	bodyBytes, _ := json.Marshal(payload)

	for attempt := 1; attempt <= 4; attempt++ {
		req, _ := http.NewRequestWithContext(ctx, "POST", createURL, bytes.NewReader(bodyBytes))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")

		resp, err := u.httpClient.Do(req)
		if err == nil {
			respBody, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusCreated {
				var folderRes struct {
					ID string `json:"id"`
				}
				if err := json.Unmarshal(respBody, &folderRes); err == nil && folderRes.ID != "" {
					log.Printf("✨ [Drive] Created new course folder '%s' (ID: %s)", cleanName, folderRes.ID)
					return folderRes.ID, nil
				}
			}
			log.Printf("⚠️ [Drive] Folder create attempt %d failed with status %d: %s", attempt, resp.StatusCode, string(respBody))
		}
		time.Sleep(time.Duration(attempt) * time.Second)
	}

	return "", fmt.Errorf("%w: '%s'", ErrFolderCreateFailed, cleanName)
}

// CheckFileExists checks if a file already exists in Drive with matching name and size (idempotency filter).
func (u *DriveUploader) CheckFileExists(ctx context.Context, token, folderID, fileName string, fileSize int64) (*model.DriveFile, bool) {
	safeName := EscapeDriveQuery(fileName)
	q := fmt.Sprintf("name = '%s' and trashed = false", safeName)
	if folderID != "" {
		q += fmt.Sprintf(" and '%s' in parents", folderID)
	}

	searchURL := fmt.Sprintf("https://www.googleapis.com/drive/v3/files?q=%s&fields=files(id,name,size,webViewLink)&supportsAllDrives=true&includeItemsFromAllDrives=true", url.QueryEscape(q))

	req, err := http.NewRequestWithContext(ctx, "GET", searchURL, nil)
	if err != nil {
		return nil, false
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := u.httpClient.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		if resp != nil {
			resp.Body.Close()
		}
		return nil, false
	}
	defer resp.Body.Close()

	var searchRes struct {
		Files []struct {
			ID          string `json:"id"`
			Name        string `json:"name"`
			Size        string `json:"size"`
			WebViewLink string `json:"webViewLink"`
		} `json:"files"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&searchRes); err == nil {
		for _, f := range searchRes.Files {
			var remoteSize int64
			if n, err := strconv.ParseInt(f.Size, 10, 64); err == nil {
				remoteSize = n
			}
			if remoteSize == fileSize || fileSize == 0 {
				link := f.WebViewLink
				if link == "" {
					link = fmt.Sprintf("https://drive.google.com/file/d/%s/view", f.ID)
				}
				return &model.DriveFile{
					Name:        f.Name,
					FileID:      f.ID,
					SizeBytes:   remoteSize,
					WebViewLink: link,
				}, true
			}
		}
	}
	return nil, false
}

func isJunkFile(name string) bool {
	lower := strings.ToLower(name)
	return lower == ".ds_store" ||
		lower == "thumbs.db" ||
		lower == "desktop.ini" ||
		strings.HasPrefix(lower, "._") ||
		strings.Contains(lower, "__macosx") ||
		strings.HasSuffix(lower, ".tmp")
}

// UploadSingleFile uploads a single file to Google Drive using either fast multipart upload (< 5MB)
// or resumable chunked upload (>= 5MB) with automatic retries and token refreshes.
func (u *DriveUploader) UploadSingleFile(
	ctx context.Context,
	token string,
	folderID string,
	localPath string,
	fileName string,
	isVideo bool,
	driveCfg *model.DriveUploadConfig,
) (*model.DriveFile, error) {
	if isJunkFile(fileName) {
		log.Printf("🗑️ [Drive] Skipping OS junk file '%s'", fileName)
		_ = os.Remove(localPath)
		return nil, nil
	}

	fi, err := os.Stat(localPath)
	if err != nil {
		return nil, fmt.Errorf("stat error for %s: %w", localPath, err)
	}
	fileSize := fi.Size()

	// Idempotency Check: Don't upload if file already exists with same size
	if ex, exists := u.CheckFileExists(ctx, token, folderID, fileName, fileSize); exists {
		log.Printf("⏩ [Drive Idempotency] '%s' already exists in Drive folder (ID: %s). Skipping re-upload!", fileName, ex.FileID)
		ex.IsVideo = isVideo
		_ = os.Remove(localPath) // Clean up local file immediately
		return ex, nil
	}

	var driveFile *model.DriveFile
	maxRetries := 4

	for attempt := 1; attempt <= maxRetries; attempt++ {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}

		// Choose upload strategy based on size
		if fileSize < 5*1024*1024 {
			driveFile, err = u.uploadMultipart(ctx, token, folderID, localPath, fileName, fileSize)
		} else {
			driveFile, err = u.uploadResumable(ctx, token, folderID, localPath, fileName, fileSize)
		}

		if err == nil && driveFile != nil {
			driveFile.IsVideo = isVideo
			// Immediate local file unlink to reclaim disk space
			_ = os.Remove(localPath)
			log.Printf("☁️ [Drive] Successfully uploaded '%s' (%.2f MB) -> FileID: %s",
				fileName, float64(fileSize)/(1024*1024), driveFile.FileID)
			return driveFile, nil
		}

		// Check for expired token (HTTP 401)
		if strings.Contains(err.Error(), "401") || strings.Contains(err.Error(), "unauthorized") {
			log.Printf("🔄 [Drive] Token expired during upload of '%s', refreshing...", fileName)
			u.InvalidateToken()
			freshTok, _, tokErr := u.GetValidAccessToken(ctx, driveCfg)
			if tokErr == nil && freshTok != "" {
				token = freshTok
			}
			time.Sleep(1 * time.Second)
			continue
		}

		// Rate limit or server error backoff
		if strings.Contains(err.Error(), "429") || strings.Contains(err.Error(), "rateLimit") ||
			strings.Contains(err.Error(), "500") || strings.Contains(err.Error(), "502") ||
			strings.Contains(err.Error(), "503") || strings.Contains(err.Error(), "504") {
			cooldown := time.Duration((1<<attempt)+rand.Intn(2)) * time.Second
			log.Printf("⚠️ [Drive] Rate limit or CDN error during '%s' (attempt %d/%d): %v. Cooling down %v...",
				fileName, attempt, maxRetries, err, cooldown)
			time.Sleep(cooldown)
			continue
		}

		log.Printf("⚠️ [Drive] Upload attempt %d failed for '%s': %v", attempt, fileName, err)
		time.Sleep(time.Duration(attempt) * time.Second)
	}

	return nil, fmt.Errorf("%w for '%s': %v", ErrUploadFailed, fileName, err)
}

func (u *DriveUploader) uploadMultipart(
	ctx context.Context,
	token string,
	folderID string,
	localPath string,
	fileName string,
	fileSize int64,
) (*model.DriveFile, error) {
	fileData, err := os.ReadFile(localPath)
	if err != nil {
		return nil, err
	}

	boundary := fmt.Sprintf("-----DriveBoundary_%d_%d", time.Now().UnixNano(), rand.Intn(10000))
	meta := map[string]interface{}{
		"name": fileName,
	}
	if folderID != "" {
		meta["parents"] = []string{folderID}
	}
	metaBytes, _ := json.Marshal(meta)

	var body bytes.Buffer
	body.WriteString("--" + boundary + "\r\n")
	body.WriteString("Content-Type: application/json; charset=UTF-8\r\n\r\n")
	body.Write(metaBytes)
	body.WriteString("\r\n--" + boundary + "\r\n")
	body.WriteString("Content-Type: application/octet-stream\r\n\r\n")
	body.Write(fileData)
	body.WriteString("\r\n--" + boundary + "--\r\n")

	uploadURL := "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true"
	req, err := http.NewRequestWithContext(ctx, "POST", uploadURL, &body)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "multipart/related; boundary="+boundary)

	resp, err := u.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(respBytes))
	}

	var res struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		WebViewLink string `json:"webViewLink"`
	}
	if err := json.Unmarshal(respBytes, &res); err != nil {
		return nil, err
	}

	link := res.WebViewLink
	if link == "" {
		link = fmt.Sprintf("https://drive.google.com/file/d/%s/view", res.ID)
	}

	return &model.DriveFile{
		Name:        fileName,
		FileID:      res.ID,
		SizeBytes:   fileSize,
		WebViewLink: link,
	}, nil
}

func (u *DriveUploader) uploadResumable(
	ctx context.Context,
	token string,
	folderID string,
	localPath string,
	fileName string,
	fileSize int64,
) (*model.DriveFile, error) {
	// 1. Initialize Resumable Session
	initURL := "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true"
	meta := map[string]interface{}{
		"name": fileName,
	}
	if folderID != "" {
		meta["parents"] = []string{folderID}
	}
	metaBytes, _ := json.Marshal(meta)

	initReq, err := http.NewRequestWithContext(ctx, "POST", initURL, bytes.NewReader(metaBytes))
	if err != nil {
		return nil, err
	}
	initReq.Header.Set("Authorization", "Bearer "+token)
	initReq.Header.Set("Content-Type", "application/json; charset=UTF-8")
	initReq.Header.Set("X-Upload-Content-Type", "application/octet-stream")

	initResp, err := u.httpClient.Do(initReq)
	if err != nil {
		return nil, fmt.Errorf("init request failed: %w", err)
	}
	defer initResp.Body.Close()

	if initResp.StatusCode != http.StatusOK && initResp.StatusCode != http.StatusCreated {
		respBody, _ := io.ReadAll(initResp.Body)
		return nil, fmt.Errorf("resumable init failed HTTP %d: %s", initResp.StatusCode, string(respBody))
	}

	sessionURI := initResp.Header.Get("Location")
	if sessionURI == "" {
		return nil, errors.New("empty Location header returned by Google Drive for resumable session")
	}

	// 2. Stream File in 8MB chunks (strictly multiple of 256 KiB)
	chunkSize := 8 * 1024 * 1024
	file, err := os.Open(localPath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	buf := make([]byte, chunkSize)
	var bytesUploaded int64

	for bytesUploaded < fileSize {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}

		currentChunkSize := chunkSize
		if bytesUploaded+int64(currentChunkSize) > fileSize {
			currentChunkSize = int(fileSize - bytesUploaded)
		}

		_, err := file.ReadAt(buf[:currentChunkSize], bytesUploaded)
		if err != nil && err != io.EOF {
			return nil, fmt.Errorf("read chunk error at %d: %w", bytesUploaded, err)
		}

		startByte := bytesUploaded
		endByte := bytesUploaded + int64(currentChunkSize) - 1

		putReq, err := http.NewRequestWithContext(ctx, "PUT", sessionURI, bytes.NewReader(buf[:currentChunkSize]))
		if err != nil {
			return nil, err
		}
		putReq.Header.Set("Content-Length", strconv.Itoa(currentChunkSize))
		putReq.Header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", startByte, endByte, fileSize))

		putResp, err := u.httpClient.Do(putReq)
		if err != nil {
			return nil, fmt.Errorf("chunk upload connection error: %w", err)
		}

		respBody, _ := io.ReadAll(putResp.Body)
		putResp.Body.Close()

		if putResp.StatusCode == 308 {
			// Chunk accepted, resume incomplete
			bytesUploaded += int64(currentChunkSize)
			continue
		} else if putResp.StatusCode == http.StatusOK || putResp.StatusCode == http.StatusCreated {
			// Final chunk uploaded successfully!
			var res struct {
				ID          string `json:"id"`
				Name        string `json:"name"`
				WebViewLink string `json:"webViewLink"`
			}
			_ = json.Unmarshal(respBody, &res)
			link := res.WebViewLink
			if link == "" {
				link = fmt.Sprintf("https://drive.google.com/file/d/%s/view", res.ID)
			}
			return &model.DriveFile{
				Name:        fileName,
				FileID:      res.ID,
				SizeBytes:   fileSize,
				WebViewLink: link,
			}, nil
		} else {
			return nil, fmt.Errorf("chunk upload failed HTTP %d: %s", putResp.StatusCode, string(respBody))
		}
	}

	return nil, errors.New("resumable upload loop finished without completion response")
}

// UploadOutputDirectory uploads all separated video files, material split zips, and manifest.json
// to Google Drive under a dedicated folder named after the course. Local files are unlinked
// progressively after each successful file upload.
func (u *DriveUploader) UploadOutputDirectory(
	ctx context.Context,
	outputDir string,
	courseTitle string,
	driveCfg *model.DriveUploadConfig,
	state *model.JobState,
	onUpdate func(),
) ([]model.DriveFile, string, error) {
	token, parentFolderID, err := u.GetValidAccessToken(ctx, driveCfg)
	if err != nil {
		return nil, "", fmt.Errorf("failed to get valid Google Drive token: %w", err)
	}

	if driveCfg != nil && driveCfg.TestFolder != "" {
		// Optional: create inside a test subfolder
		testParent, err := u.EnsureSubfolder(ctx, token, parentFolderID, driveCfg.TestFolder)
		if err == nil && testParent != "" {
			parentFolderID = testParent
		}
	}

	// 1. Ensure Course Folder exists
	courseFolderID, err := u.EnsureSubfolder(ctx, token, parentFolderID, courseTitle)
	if err != nil {
		return nil, "", err
	}
	state.DriveFolderID = courseFolderID
	state.DriveFolderURL = fmt.Sprintf("https://drive.google.com/drive/folders/%s", courseFolderID)
	onUpdate()

	var uploadedFiles []model.DriveFile

	// 2. Discover all files to upload
	var localFiles []struct {
		path    string
		name    string
		isVideo bool
	}

	_ = filepath.Walk(outputDir, func(p string, fi os.FileInfo, err error) error {
		if err == nil && !fi.IsDir() {
			name := fi.Name()
			if !isJunkFile(name) {
				lower := strings.ToLower(name)
				isVideo := strings.HasSuffix(lower, ".mp4") || strings.HasSuffix(lower, ".mkv") ||
					strings.HasSuffix(lower, ".avi") || strings.HasSuffix(lower, ".mov") ||
					strings.HasSuffix(lower, ".webm") || strings.HasSuffix(lower, ".flv")
				localFiles = append(localFiles, struct {
					path    string
					name    string
					isVideo bool
				}{path: p, name: name, isVideo: isVideo})
			}
		}
		return nil
	})

	log.Printf("🚀 [Drive] Starting upload of %d file(s) to folder '%s' (ID: %s)...",
		len(localFiles), courseTitle, courseFolderID)

	for i, f := range localFiles {
		select {
		case <-ctx.Done():
			return uploadedFiles, courseFolderID, ctx.Err()
		default:
		}

		log.Printf("☁️ [Drive] Uploading %d/%d: %s...", i+1, len(localFiles), f.name)
		df, err := u.UploadSingleFile(ctx, token, courseFolderID, f.path, f.name, f.isVideo, driveCfg)
		if err != nil {
			return uploadedFiles, courseFolderID, fmt.Errorf("failed to upload %s: %w", f.name, err)
		}
		if df != nil {
			uploadedFiles = append(uploadedFiles, *df)
			state.DriveFiles = uploadedFiles
			onUpdate()
		}
	}

	// 3. Sync to Neon DB course_tasks if database is configured
	if u.cfg.DatabaseURL != "" {
		_ = u.syncToNeonDB(ctx, state.ID, courseTitle, courseFolderID, uploadedFiles)
	}

	return uploadedFiles, courseFolderID, nil
}

func (u *DriveUploader) syncToNeonDB(ctx context.Context, taskID, courseTitle, folderID string, files []model.DriveFile) error {
	db, err := sql.Open("postgres", u.cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer db.Close()

	var videos []map[string]interface{}
	for _, f := range files {
		if f.IsVideo {
			videos = append(videos, map[string]interface{}{
				"fileName":      f.Name,
				"size":          f.SizeBytes,
				"driveFileId":   f.FileID,
				"driveViewLink": f.WebViewLink,
			})
		}
	}
	videosJSON, _ := json.Marshal(videos)

	syncCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	nowMs := time.Now().UnixMilli()
	// Update by ID or by course_name
	_, err = db.ExecContext(syncCtx, `
		UPDATE course_tasks
		SET status = 'completed',
		    created_folder_id = $1,
		    created_folder_name = $2,
		    extracted_videos = $3,
		    updated_at = $4,
		    error_message = NULL
		WHERE id = $5 OR course_name = $2
	`, folderID, courseTitle, videosJSON, nowMs, taskID)

	if err == nil {
		log.Printf("💾 [Drive DB Sync] Synced course '%s' completion to Neon PostgreSQL course_tasks table", courseTitle)
	}
	return err
}
