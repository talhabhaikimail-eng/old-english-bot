package main

import (
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

type TunnelOptions struct {
	ServiceName    string
	DomainMode     string
	CustomDomain   string
	HostPort       int
	SessionHash    string
	CleanName      string
	ReuseTunnel    bool
	OldTunnelToken string
	OldTunnelID    string
}

type TunnelResult struct {
	TunnelID       string
	TunnelToken    string
	TunnelPid      int
	CloudflaredURL string
}

func cleanCustomDomainAndHostname(input string) (string, string) {
	input = strings.TrimSpace(input)
	input = strings.Trim(input, "\"'`")
	// Remove protocol
	clean := strings.TrimPrefix(input, "https://")
	clean = strings.TrimPrefix(clean, "http://")
	// Remove trailing paths / queries / ports
	if idx := strings.Index(clean, "/"); idx != -1 {
		clean = clean[:idx]
	}
	if idx := strings.Index(clean, "?"); idx != -1 {
		clean = clean[:idx]
	}
	if idx := strings.Index(clean, ":"); idx != -1 {
		clean = clean[:idx]
	}
	hostname := strings.ToLower(strings.TrimSpace(strings.Trim(clean, "./")))
	if hostname == "" {
		hostname = "localhost"
	}
	targetURL := "https://" + hostname
	return targetURL, hostname
}

func extractTunnelIDFromToken(token string) string {
	token = strings.TrimSpace(strings.Trim(token, "\"'`"))
	if token == "" {
		return ""
	}
	// Try standard base64 and URL-safe base64 decoders
	var decoders = []*base64.Encoding{
		base64.StdEncoding,
		base64.RawStdEncoding,
		base64.URLEncoding,
		base64.RawURLEncoding,
	}
	for _, enc := range decoders {
		if decodedBytes, err := enc.DecodeString(token); err == nil {
			var decoded map[string]interface{}
			if err := json.Unmarshal(decodedBytes, &decoded); err == nil {
				if t, ok := decoded["t"].(string); ok && t != "" {
					return t
				}
			}
		}
	}
	return ""
}

func callCloudflareAPI(method, urlStr string, body []byte, apiToken string) (map[string]interface{}, error) {
	var bodyReader *bytes.Buffer
	if body != nil {
		bodyReader = bytes.NewBuffer(body)
	}
	var req *http.Request
	var err error
	if bodyReader != nil {
		req, err = http.NewRequest(method, urlStr, bodyReader)
	} else {
		req, err = http.NewRequest(method, urlStr, nil)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to create http request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+apiToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http request failed: %w", err)
	}
	defer resp.Body.Close()

	var res map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, fmt.Errorf("failed to decode response (status %d): %w", resp.StatusCode, err)
	}

	if resp.StatusCode >= 400 {
		var errMsgs []string
		if errs, ok := res["errors"].([]interface{}); ok {
			for _, e := range errs {
				if eMap, ok := e.(map[string]interface{}); ok {
					if msg, ok := eMap["message"].(string); ok {
						errMsgs = append(errMsgs, msg)
					}
				}
			}
		}
		if len(errMsgs) > 0 {
			return nil, fmt.Errorf("Cloudflare API error (status %d): %s", resp.StatusCode, strings.Join(errMsgs, ", "))
		}
		return nil, fmt.Errorf("Cloudflare API error (status %d)", resp.StatusCode)
	}

	if success, ok := res["success"].(bool); ok && !success {
		return nil, fmt.Errorf("Cloudflare API reported success: false")
	}

	return res, nil
}

func getZoneIDForHostname(hostname, envZoneID, apiToken string) string {
	if strings.HasSuffix(hostname, "talhacodes.site") {
		return "bdab676dc795f7321758573495898fd0"
	}
	if strings.HasSuffix(hostname, "ufone-claim.site") {
		return "743f86bdacd1b4fa23620db280c6d05f"
	}
	if strings.HasSuffix(hostname, "curealog.com") {
		return "165dddfd4040f04cc80f26cfac5db101"
	}
	if envZoneID != "" {
		return envZoneID
	}
	if apiToken != "" {
		parts := strings.Split(hostname, ".")
		if len(parts) >= 2 {
			rootDomain := strings.Join(parts[len(parts)-2:], ".")
			url := fmt.Sprintf("https://api.cloudflare.com/client/v4/zones?name=%s", rootDomain)
			res, err := callCloudflareAPI("GET", url, nil, apiToken)
			if err == nil {
				if results, ok := res["result"].([]interface{}); ok && len(results) > 0 {
					if rec, ok := results[0].(map[string]interface{}); ok {
						if id, ok := rec["id"].(string); ok && id != "" {
							return id
						}
					}
				}
			}
		}
	}
	return envZoneID
}

func provisionTunnel(opts TunnelOptions) (TunnelResult, error) {
	var res TunnelResult

	// Wait for the container/service port to start listening
	log.Printf("[Cloudflare Tunnel] Waiting for port %d to start listening...", opts.HostPort)
	if !waitForPort(opts.HostPort, 15*time.Second) {
		log.Printf("[Cloudflare Tunnel] Warning: Port %d did not start listening within timeout. Connecting tunnel anyway...", opts.HostPort)
	} else {
		log.Printf("[Cloudflare Tunnel] Port %d is active. Setting up tunnel...", opts.HostPort)
	}

	if opts.DomainMode == "custom" {
		if strings.TrimSpace(opts.CustomDomain) == "" {
			return res, errors.New("custom domain is required when domain mode is custom")
		}

		targetURL, hostnameOnly := cleanCustomDomainAndHostname(opts.CustomDomain)
		res.CloudflaredURL = targetURL
		log.Printf("[Cloudflare Tunnel] Custom domain configured: %s (hostname: %s)", targetURL, hostnameOnly)

		accountID := getSanitizedEnv("CLOUDFLARE_ACCOUNT_ID")
		envZoneID := getSanitizedEnv("CLOUDFLARE_ZONE_ID")
		apiToken := getSanitizedEnv("CLOUDFLARE_API_TOKEN")
		zoneID := getZoneIDForHostname(hostnameOnly, envZoneID, apiToken)

		res.TunnelToken = strings.TrimSpace(opts.OldTunnelToken)
		res.TunnelID = strings.TrimSpace(opts.OldTunnelID)

		if res.TunnelID == "" && res.TunnelToken != "" {
			res.TunnelID = extractTunnelIDFromToken(res.TunnelToken)
		}

		// If no tunnel token is provided (or not reusing a token), auto-configure a new Cloudflare Named Tunnel
		if res.TunnelToken == "" {
			if accountID == "" || zoneID == "" || apiToken == "" {
				return res, errors.New("missing Cloudflare Credentials (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID, CLOUDFLARE_API_TOKEN) in environment to auto-configure custom domain")
			}

			log.Printf("[Cloudflare Tunnel] Auto-configuring Cloudflare Tunnel for %s...", opts.ServiceName)
			tSecretBytes := make([]byte, 32)
			if _, err := rand.Read(tSecretBytes); err != nil {
				return res, fmt.Errorf("failed to generate secure random bytes: %w", err)
			}
			tSecretBase64 := base64.StdEncoding.EncodeToString(tSecretBytes)

			cleanName := regexp.MustCompile(`[^a-zA-Z0-9_-]`).ReplaceAllString(opts.CleanName, "_")
			if cleanName == "" {
				cleanName = "custom-app"
			}
			tunnelName := fmt.Sprintf("tunnel-%s-%s", cleanName, opts.SessionHash)
			if len(tunnelName) > 120 {
				tunnelName = tunnelName[:120]
			}

			// 1. Create Tunnel
			tBody, _ := json.Marshal(map[string]string{
				"name":          tunnelName,
				"tunnel_secret": tSecretBase64,
			})
			urlStr := fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/cfd_tunnel", accountID)
			apiRes, err := callCloudflareAPI("POST", urlStr, tBody, apiToken)
			if err != nil {
				return res, fmt.Errorf("failed to create tunnel: %w", err)
			}
			if result, _ := apiRes["result"].(map[string]interface{}); result != nil {
				res.TunnelID, _ = result["id"].(string)
			}
			if res.TunnelID == "" {
				return res, errors.New("cloudflare tunnel ID not returned in response")
			}
			log.Printf("[Cloudflare Tunnel] Created Cloudflare Tunnel: %s", res.TunnelID)

			// 2. Configure Ingress Rules (Matching Node custom-container.ts: http://localhost:<port>)
			ingressBody, _ := json.Marshal(map[string]interface{}{
				"config": map[string]interface{}{
					"ingress": []map[string]interface{}{
						{"hostname": hostnameOnly, "service": fmt.Sprintf("http://localhost:%d", opts.HostPort)},
						{"service": "http_status:404"},
					},
				},
			})
			urlStr = fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/cfd_tunnel/%s/configurations", accountID, res.TunnelID)
			_, err = callCloudflareAPI("PUT", urlStr, ingressBody, apiToken)
			if err != nil {
				// Cleanup the created tunnel before returning error
				_ = deleteCloudflareTunnelOnly(res.TunnelID, accountID, apiToken)
				return res, fmt.Errorf("failed to configure ingress rules: %w", err)
			}
			log.Printf("[Cloudflare Tunnel] Cloudflare Ingress Rules configured for %s -> localhost:%d", hostnameOnly, opts.HostPort)

			// 3. Create or Update DNS CNAME Mapping
			// Search for any existing DNS record with this hostname (without restricting type=CNAME)
			var dnsRecordID = ""
			dnsListUrl := fmt.Sprintf("https://api.cloudflare.com/client/v4/zones/%s/dns_records?name=%s", zoneID, hostnameOnly)
			dnsListRes, err := callCloudflareAPI("GET", dnsListUrl, nil, apiToken)
			if err == nil {
				if results, ok := dnsListRes["result"].([]interface{}); ok && len(results) > 0 {
					if record, ok := results[0].(map[string]interface{}); ok {
						dnsRecordID, _ = record["id"].(string)
					}
				}
			}

			dnsUrl := ""
			dnsMethod := ""
			if dnsRecordID != "" {
				dnsUrl = fmt.Sprintf("https://api.cloudflare.com/client/v4/zones/%s/dns_records/%s", zoneID, dnsRecordID)
				dnsMethod = "PUT"
			} else {
				dnsUrl = fmt.Sprintf("https://api.cloudflare.com/client/v4/zones/%s/dns_records", zoneID)
				dnsMethod = "POST"
			}

			dnsBody, _ := json.Marshal(map[string]interface{}{
				"type":    "CNAME",
				"name":    hostnameOnly,
				"content": fmt.Sprintf("%s.cfargotunnel.com", res.TunnelID),
				"proxied": true,
			})
			_, err = callCloudflareAPI(dnsMethod, dnsUrl, dnsBody, apiToken)
			if err != nil {
				// Log DNS warning instead of fatally destroying the tunnel, matching custom-container.ts behavior
				log.Printf("[Cloudflare Tunnel] Warning: DNS record creation/update returned: %v (tunnel is active)", err)
			} else {
				log.Printf("[Cloudflare Tunnel] DNS Record mapped %s -> %s.cfargotunnel.com", hostnameOnly, res.TunnelID)
			}

			// Token base64
			tokenPayload := map[string]string{"a": accountID, "t": res.TunnelID, "s": tSecretBase64}
			tokenJson, _ := json.Marshal(tokenPayload)
			res.TunnelToken = base64.StdEncoding.EncodeToString(tokenJson)
		} else {
			// Tunnel token is already present (reused or provided)
			if res.TunnelID != "" && accountID != "" && apiToken != "" {
				log.Printf("[Cloudflare Tunnel] Updating Ingress Rules for existing Cloudflare Tunnel %s to point to port %d...", res.TunnelID, opts.HostPort)
				ingressBody, _ := json.Marshal(map[string]interface{}{
					"config": map[string]interface{}{
						"ingress": []map[string]interface{}{
							{"hostname": hostnameOnly, "service": fmt.Sprintf("http://localhost:%d", opts.HostPort)},
							{"service": "http_status:404"},
						},
					},
				})
				urlStr := fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/cfd_tunnel/%s/configurations", accountID, res.TunnelID)
				_, err := callCloudflareAPI("PUT", urlStr, ingressBody, apiToken)
				if err != nil {
					log.Printf("[Cloudflare Tunnel] Warning: Failed to update ingress rules on reused tunnel: %v", err)
				} else {
					log.Printf("[Cloudflare Tunnel] Ingress Rules updated on reused tunnel.")
				}
			}
		}

		if res.TunnelToken != "" {
			log.Printf("[Cloudflare Tunnel] Starting Cloudflare Named Tunnel for %s...", targetURL)
			tCmd := exec.Command("cloudflared", "tunnel", "--no-autoupdate", "run", "--token", res.TunnelToken)
			if err := tCmd.Start(); err == nil {
				res.TunnelPid = tCmd.Process.Pid
				log.Printf("[Cloudflare Tunnel] Tunnel process started with PID %d", res.TunnelPid)
				waitForHealthyStatus(targetURL, opts.HostPort, 35*time.Second)
				return res, nil
			} else {
				return res, fmt.Errorf("failed to start cloudflared tunnel command: %w", err)
			}
		}
		return res, errors.New("cloudflare tunnel token is empty")
	}

	if opts.DomainMode == "quick" {
		tCmd := exec.Command("cloudflared", "tunnel", "--url", fmt.Sprintf("http://localhost:%d", opts.HostPort))
		stderr, err := tCmd.StderrPipe()
		if err != nil {
			return res, fmt.Errorf("failed to open stderr pipe for cloudflared: %w", err)
		}

		if err := tCmd.Start(); err != nil {
			return res, fmt.Errorf("failed to start cloudflared quick tunnel: %w", err)
		}

		res.TunnelPid = tCmd.Process.Pid
		urlChan := make(chan string, 1)
		errChan := make(chan error, 1)

		go func() {
			buf := make([]byte, 1024)
			var accumulated string
			re := regexp.MustCompile(`https://[-0-9a-z]*\.trycloudflare\.com`)
			urlSent := false

			for {
				n, err := stderr.Read(buf)
				if n > 0 {
					if !urlSent {
						accumulated += string(buf[:n])
						if match := re.FindString(accumulated); match != "" {
							urlChan <- match
							urlSent = true
						}
					}
				}
				if err != nil {
					if !urlSent {
						errChan <- err
					}
					return
				}
			}
		}()

		select {
		case cUrl := <-urlChan:
			res.CloudflaredURL = cUrl
			waitForHealthyStatus(cUrl, opts.HostPort, 35*time.Second)
			return res, nil
		case <-errChan:
			tCmd.Process.Kill()
			return res, errors.New("cloudflare quick tunnel failed to write URL to stderr")
		case <-time.After(30 * time.Second):
			tCmd.Process.Kill()
			return res, errors.New("cloudflare quick tunnel timed out")
		}
	}

	return res, fmt.Errorf("unknown domain mode: %s", opts.DomainMode)
}

func deleteCloudflareTunnelOnly(tunnelID, accountID, apiToken string) error {
	if tunnelID == "" || accountID == "" || apiToken == "" {
		return nil
	}
	url := fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/cfd_tunnel/%s", accountID, tunnelID)
	req, _ := http.NewRequest("DELETE", url, nil)
	req.Header.Set("Authorization", "Bearer "+apiToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err == nil {
		resp.Body.Close()
	}
	return err
}

func cleanupCloudflareResources(meta SessionMetadata) {
	if meta.TunnelPid > 0 {
		if proc, err := os.FindProcess(meta.TunnelPid); err == nil {
			log.Printf("[Cloudflare Cleanup] Killing tunnel process PID %d...", meta.TunnelPid)
			_ = proc.Kill()
		}
	}

	accountID := getSanitizedEnv("CLOUDFLARE_ACCOUNT_ID")
	envZoneID := getSanitizedEnv("CLOUDFLARE_ZONE_ID")
	apiToken := getSanitizedEnv("CLOUDFLARE_API_TOKEN")

	if meta.TunnelID != "" && accountID != "" && apiToken != "" {
		log.Printf("[Cloudflare Cleanup] Deleting Cloudflare tunnel %s...", meta.TunnelID)
		time.Sleep(2 * time.Second)
		_ = deleteCloudflareTunnelOnly(meta.TunnelID, accountID, apiToken)
	}

	if meta.CustomDomain != "" && apiToken != "" {
		_, hostname := cleanCustomDomainAndHostname(meta.CustomDomain)
		zoneID := getZoneIDForHostname(hostname, envZoneID, apiToken)
		if zoneID == "" {
			return
		}
		log.Printf("[Cloudflare Cleanup] Cleaning up DNS CNAME record for %s (zone: %s)...", hostname, zoneID)

		url := fmt.Sprintf("https://api.cloudflare.com/client/v4/zones/%s/dns_records?name=%s&type=CNAME", zoneID, hostname)
		req, _ := http.NewRequest("GET", url, nil)
		req.Header.Set("Authorization", "Bearer "+apiToken)

		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			defer resp.Body.Close()
			var dnsList map[string]interface{}
			json.NewDecoder(resp.Body).Decode(&dnsList)
			if success, _ := dnsList["success"].(bool); success {
				results, _ := dnsList["result"].([]interface{})
				if len(results) > 0 {
					record, _ := results[0].(map[string]interface{})
					recordID, _ := record["id"].(string)

					delUrl := fmt.Sprintf("https://api.cloudflare.com/client/v4/zones/%s/dns_records/%s", zoneID, recordID)
					delReq, _ := http.NewRequest("DELETE", delUrl, nil)
					delReq.Header.Set("Authorization", "Bearer "+apiToken)

					if delResp, err := http.DefaultClient.Do(delReq); err == nil {
						delResp.Body.Close()
						log.Printf("[Cloudflare Cleanup] Deleted DNS record for %s", hostname)
					}
				}
			}
		}
	}
}

func waitForPort(port int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond)
		if err == nil {
			conn.Close()
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

// waitForHealthyStatus polls the given target URL every 1 second until a healthy HTTP status (< 500 and != 530) is returned.
func waitForHealthyStatus(targetURL string, hostPort int, timeout time.Duration) bool {
	return waitForHealthyStatusWithJob("", targetURL, hostPort, timeout)
}

// waitForHealthyStatusWithJob polls targetURL every 1 second and appends real-time progress logs to the job.
func waitForHealthyStatusWithJob(jobID, targetURL string, hostPort int, timeout time.Duration) bool {
	if hostPort > 0 {
		log.Printf("[Health Check] Checking local port %d...", hostPort)
		if !waitForPort(hostPort, 15*time.Second) {
			log.Printf("[Health Check] Local port %d is not yet accepting connections, continuing to check URL...", hostPort)
		}
	}

	if targetURL == "" || !strings.HasPrefix(targetURL, "http") {
		return true
	}

	log.Printf("[Health Check] Testing %s with 1s delay loop until healthy status is returned (timeout %v)...", targetURL, timeout)
	if jobID != "" {
		addJobLog(jobID, fmt.Sprintf("[Health Check] Testing %s (1s delay loop) until healthy...", targetURL))
	}

	client := &http.Client{
		Timeout: 2 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
	}

	deadline := time.Now().Add(timeout)
	attempt := 0

	for time.Now().Before(deadline) {
		attempt++
		req, err := http.NewRequest("GET", targetURL, nil)
		if err == nil {
			req.Header.Set("User-Agent", "Go-Container-Manager-HealthCheck/1.0")
			resp, err := client.Do(req)
			if err == nil {
				statusCode := resp.StatusCode
				resp.Body.Close()

				// Status < 500 and not 530 (Cloudflare Error 1033) means tunnel + upstream app is responsive
				if statusCode < 500 && statusCode != 530 {
					log.Printf("[Health Check] ✅ Target %s is healthy! (HTTP Status %d after attempt %d)", targetURL, statusCode, attempt)
					if jobID != "" {
						addJobLog(jobID, fmt.Sprintf("[Health Check] ✅ Target %s is verified healthy (HTTP %d)", targetURL, statusCode))
					}
					return true
				}
				log.Printf("[Health Check] Attempt %d: %s returned status %d (not ready yet), retrying in 1s...", attempt, targetURL, statusCode)
				if jobID != "" && attempt%3 == 0 {
					addJobLog(jobID, fmt.Sprintf("[Health Check] Attempt %d: Waiting for healthy status on %s (current status: %d)...", attempt, targetURL, statusCode))
				}
			} else {
				log.Printf("[Health Check] Attempt %d: Request to %s failed (%v), retrying in 1s...", attempt, targetURL, err)
			}
		}
		time.Sleep(1 * time.Second)
	}

	log.Printf("[Health Check] ⚠️ Warning: Endpoint %s did not become healthy within %v. Proceeding.", targetURL, timeout)
	if jobID != "" {
		addJobLog(jobID, fmt.Sprintf("[Health Check] ⚠️ Warning: Timeout waiting for %s to return healthy status. Proceeding.", targetURL))
	}
	return false
}
