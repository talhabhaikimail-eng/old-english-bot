package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type VolumeBackupRequest struct {
	Volume string `json:"volume"`
}

func getS3Client() (*s3.Client, string, error) {
	accessKey := getSanitizedEnv("R2_ACCESS_KEY_ID")
	secretKey := getSanitizedEnv("R2_SECRET_ACCESS_KEY")
	bucket := getSanitizedEnv("R2_BUCKET_NAME")
	accountID := getSanitizedEnv("R2_ACCOUNT_ID")

	if accessKey == "" || secretKey == "" || bucket == "" || accountID == "" {
		return nil, "", fmt.Errorf("missing R2 configuration variables (R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_ACCOUNT_ID)")
	}

	cfg, err := config.LoadDefaultConfig(context.TODO(),
		config.WithRegion("auto"),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKey, secretKey, "")),
	)
	if err != nil {
		return nil, "", err
	}

	endpoint := fmt.Sprintf("https://%s.r2.cloudflarestorage.com", accountID)
	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = &endpoint
		o.UsePathStyle = true
	})

	return client, bucket, nil
}

func tarFolder(srcDir string, destTarPath string) error {
	fw, err := os.Create(destTarPath)
	if err != nil {
		return err
	}
	defer fw.Close()

	gw := gzip.NewWriter(fw)
	defer gw.Close()

	tw := tar.NewWriter(gw)
	defer tw.Close()

	return filepath.Walk(srcDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(filepath.Dir(srcDir), path)
		if err != nil {
			return err
		}
		header, err := tar.FileInfoHeader(info, info.Name())
		if err != nil {
			return err
		}
		header.Name = filepath.ToSlash(rel)
		if err := tw.WriteHeader(header); err != nil {
			return err
		}
		if info.Mode().IsDir() {
			return nil
		}
		fr, err := os.Open(path)
		if err != nil {
			return err
		}
		defer fr.Close()
		_, err = io.Copy(tw, fr)
		return err
	})
}

func backupStateToR2() error {
	client, bucket, err := getS3Client()
	if err != nil {
		return err
	}

	root := findWorkspaceRoot()
	authInfoDir := filepath.Join(root, "auth_info")
	tarPath := filepath.Join(root, "state.tar.gz")

	if _, err := os.Stat(authInfoDir); os.IsNotExist(err) {
		return fmt.Errorf("auth_info folder not found")
	}

	if err := tarFolder(authInfoDir, tarPath); err != nil {
		return fmt.Errorf("failed to tar auth_info: %w", err)
	}
	defer os.Remove(tarPath)

	file, err := os.Open(tarPath)
	if err != nil {
		return err
	}
	defer file.Close()

	key := "state.tar.gz"
	_, err = client.PutObject(context.TODO(), &s3.PutObjectInput{
		Bucket: &bucket,
		Key:    &key,
		Body:   file,
	})
	return err
}

func handleBackupVolume(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	var req VolumeBackupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.Volume == "" {
		writeError(w, http.StatusBadRequest, "Missing volume name")
		return
	}

	client, bucket, err := getS3Client()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Create backups directory in workspace
	root := findWorkspaceRoot()
	backupsDir := filepath.Join(root, "backups")
	_ = os.MkdirAll(backupsDir, 0755)

	tarFile := filepath.Join(backupsDir, fmt.Sprintf("%s.tar.gz", req.Volume))
	defer os.Remove(tarFile)

	// Since we are running in GH actions (Linux) or local Docker, we run a temporary container to tar the volume.
	// We mount the target volume to /data, and the backups host folder to /backup.
	cmd := exec.Command("docker", "run", "--rm",
		"-v", fmt.Sprintf("%s:/data", req.Volume),
		"-v", fmt.Sprintf("%s:/backup", backupsDir),
		"alpine", "tar", "-czf", fmt.Sprintf("/backup/%s.tar.gz", req.Volume), "-C", "/data", ".")

	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to tar docker volume: %v (stderr: %s)", err, stderr.String()))
		return
	}

	// Upload to R2
	file, err := os.Open(tarFile)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to open tar file: "+err.Error())
		return
	}
	defer file.Close()

	key := fmt.Sprintf("volumes/%s.tar.gz", req.Volume)
	_, err = client.PutObject(context.TODO(), &s3.PutObjectInput{
		Bucket: &bucket,
		Key:    &key,
		Body:   file,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to upload to Cloudflare R2: "+err.Error())
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"message": fmt.Sprintf("Volume '%s' backed up successfully to R2.", req.Volume),
	})
}

func handleRestoreVolume(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	var req VolumeBackupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	if req.Volume == "" {
		writeError(w, http.StatusBadRequest, "Missing volume name")
		return
	}

	client, bucket, err := getS3Client()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Create backups directory in workspace
	root := findWorkspaceRoot()
	backupsDir := filepath.Join(root, "backups")
	_ = os.MkdirAll(backupsDir, 0755)

	tarFile := filepath.Join(backupsDir, fmt.Sprintf("%s.tar.gz", req.Volume))
	defer os.Remove(tarFile)

	// Download from R2
	key := fmt.Sprintf("volumes/%s.tar.gz", req.Volume)
	res, err := client.GetObject(context.TODO(), &s3.GetObjectInput{
		Bucket: &bucket,
		Key:    &key,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to fetch backup from Cloudflare R2: "+err.Error())
		return
	}
	defer res.Body.Close()

	out, err := os.Create(tarFile)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to create temp tar file: "+err.Error())
		return
	}
	if _, err := io.Copy(out, res.Body); err != nil {
		out.Close()
		writeError(w, http.StatusInternalServerError, "Failed to write temp tar file: "+err.Error())
		return
	}
	out.Close()

	// Ensure the named volume exists first
	_ = exec.Command("docker", "volume", "create", req.Volume).Run()

	// Run container to untar volume contents
	cmd := exec.Command("docker", "run", "--rm",
		"-v", fmt.Sprintf("%s:/data", req.Volume),
		"-v", fmt.Sprintf("%s:/backup", backupsDir),
		"alpine", "tar", "-xzf", fmt.Sprintf("/backup/%s.tar.gz", req.Volume), "-C", "/data")

	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("Failed to extract docker volume: %v (stderr: %s)", err, stderr.String()))
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"message": fmt.Sprintf("Volume '%s' restored successfully from R2.", req.Volume),
	})
}

func handleListBackups(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		writeError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	client, bucket, err := getS3Client()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	prefix := "volumes/"
	res, err := client.ListObjectsV2(context.TODO(), &s3.ListObjectsV2Input{
		Bucket: &bucket,
		Prefix: &prefix,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to list R2 backups: "+err.Error())
		return
	}

	var backups []string
	for _, obj := range res.Contents {
		name := strings.TrimPrefix(*obj.Key, prefix)
		name = strings.TrimSuffix(name, ".tar.gz")
		if name != "" {
			backups = append(backups, name)
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"backups": backups,
	})
}
