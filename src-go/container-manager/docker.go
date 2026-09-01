package main

import (
	"bytes"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

type PortMapping struct {
	Host      int    `json:"host"`
	Container int    `json:"container"`
	Protocol  string `json:"protocol"` // "tcp" or "udp"
}

type VolumeMount struct {
	Source      string `json:"source"` // Volume name or host path
	Destination string `json:"destination"`
	ReadOnly    bool   `json:"readOnly"`
}

type RegistryAuth struct {
	Server   string `json:"server"`
	Username string `json:"username"`
	Password string `json:"password"`
}

type RunOptions struct {
	Image         string
	ContainerName string
	Port          int // Legacy compatibility
	HostPort      int // Legacy compatibility
	Env           map[string]string
	Ports         []PortMapping
	Volumes       []VolumeMount
	MemoryLimitMB int
	Cpus          float64
	RestartPolicy string // "unless-stopped" | "on-failure" | "no"
	RegistryAuth  *RegistryAuth
	Command       []string
	Args          []string
}

func verifyDockerRunning() error {
	if err := exec.Command("docker", "--version").Run(); err != nil {
		return fmt.Errorf("Docker is not running on the host system")
	}
	return nil
}

func dockerStopAndRemove(containerName string) error {
	log.Printf("[Docker] Stopping and removing container %s...", containerName)
	_ = exec.Command("docker", "stop", containerName).Run()
	cmd := exec.Command("docker", "rm", "-f", containerName)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		log.Printf("[Docker] Warning: failed to remove container %s: %v (stderr: %s)", containerName, err, stderr.String())
		return err
	}
	return nil
}

func validateVolumeSource(source string) (string, error) {
	// Simple alphanumeric volume name
	if regexp.MustCompile(`^[a-zA-Z0-9_-]+$`).MatchString(source) {
		return source, nil
	}
	// Absolute or relative path cleanup
	cleanPath := filepath.Clean(source)
	absPath, err := filepath.Abs(cleanPath)
	if err != nil {
		return "", fmt.Errorf("invalid path format: %w", err)
	}
	root := findWorkspaceRoot()
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	// Secure check: must be inside workspace root
	if !strings.HasPrefix(absPath, absRoot) {
		return "", fmt.Errorf("volume path %s is not inside the workspace directory (%s)", absPath, absRoot)
	}
	return absPath, nil
}

func pullImageWithAuth(image string, auth *RegistryAuth, jobID string) error {
	logMsg := func(msg string) {
		if jobID != "" {
			addJobLog(jobID, msg)
		} else {
			log.Println(msg)
		}
	}

	if auth == nil || auth.Username == "" || auth.Password == "" {
		logMsg(fmt.Sprintf("[Docker] Pulling public image: %s", image))
		cmd := exec.Command("docker", "pull", image)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("pull failed: %w (stderr: %s)", err, stderr.String())
		}
		return nil
	}

	logMsg(fmt.Sprintf("[Docker] Authenticating against registry %s...", auth.Server))
	tmpConfigDir, err := os.MkdirTemp("", "docker-config-")
	if err != nil {
		return fmt.Errorf("failed to create temp config directory: %w", err)
	}
	defer os.RemoveAll(tmpConfigDir)

	server := auth.Server
	if server == "" {
		server = "docker.io"
	}

	cmd := exec.Command("docker", "--config", tmpConfigDir, "login", server, "-u", auth.Username, "--password-stdin")
	cmd.Stdin = strings.NewReader(auth.Password)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("registry login failed: %w (stderr: %s)", err, stderr.String())
	}

	logMsg(fmt.Sprintf("[Docker] Pulling private image %s...", image))
	pullCmd := exec.Command("docker", "--config", tmpConfigDir, "pull", image)
	var pullStderr bytes.Buffer
	pullCmd.Stderr = &pullStderr
	if err := pullCmd.Run(); err != nil {
		return fmt.Errorf("pull failed: %w (stderr: %s)", err, pullStderr.String())
	}
	return nil
}

func dockerRunWithJob(opts RunOptions, jobID string) error {
	logMsg := func(msg string) {
		if jobID != "" {
			addJobLog(jobID, msg)
		} else {
			log.Println(msg)
		}
	}

	// Pull image first with authentication if provided
	if err := pullImageWithAuth(opts.Image, opts.RegistryAuth, jobID); err != nil {
		return err
	}

	// Initialize basic run args
	restartPolicy := opts.RestartPolicy
	if restartPolicy == "" {
		restartPolicy = "unless-stopped"
	}

	runArgs := []string{"run", "-d", "--restart", restartPolicy, "--name", opts.ContainerName}

	// Add Environment variables
	for k, v := range opts.Env {
		runArgs = append(runArgs, "-e", fmt.Sprintf("%s=%s", k, v))
	}

	// Add Port mappings
	if len(opts.Ports) > 0 {
		for _, p := range opts.Ports {
			proto := "tcp"
			if p.Protocol != "" {
				proto = strings.ToLower(p.Protocol)
			}
			runArgs = append(runArgs, "-p", fmt.Sprintf("%d:%d/%s", p.Host, p.Container, proto))
		}
	} else if opts.Port > 0 && opts.HostPort > 0 {
		// Fallback to legacy single port mapping
		runArgs = append(runArgs, "-p", fmt.Sprintf("%d:%d", opts.HostPort, opts.Port))
	}

	// Add Volume mounts
	for _, v := range opts.Volumes {
		src, err := validateVolumeSource(v.Source)
		if err != nil {
			return err
		}
		mode := "rw"
		if v.ReadOnly {
			mode = "ro"
		}
		runArgs = append(runArgs, "-v", fmt.Sprintf("%s:%s:%s", src, v.Destination, mode))
	}

	// Add Resource Limits
	if opts.MemoryLimitMB > 0 {
		runArgs = append(runArgs, fmt.Sprintf("--memory=%dm", opts.MemoryLimitMB))
	}
	if opts.Cpus > 0 {
		runArgs = append(runArgs, fmt.Sprintf("--cpus=%.2f", opts.Cpus))
	}

	// Add image name
	runArgs = append(runArgs, "--", opts.Image)

	// Add command and args overrides if present
	if len(opts.Command) > 0 {
		runArgs = append(runArgs, opts.Command...)
	}
	if len(opts.Args) > 0 {
		runArgs = append(runArgs, opts.Args...)
	}

	logMsg(fmt.Sprintf("[Docker] Starting container: docker %s", strings.Join(runArgs, " ")))
	cmd := exec.Command("docker", runArgs...)
	var runStderr bytes.Buffer
	cmd.Stderr = &runStderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("docker run failed: %w (stderr: %s)", err, runStderr.String())
	}
	return nil
}

func dockerRun(opts RunOptions) error {
	return dockerRunWithJob(opts, "")
}

func dockerComposeDown(composeFile string) error {
	log.Printf("[Docker Compose] Stopping stack: %s", composeFile)
	err1 := exec.Command("docker", "compose", "-f", composeFile, "down").Run()
	err2 := exec.Command("docker-compose", "-f", composeFile, "down").Run()
	if err1 != nil && err2 != nil {
		return fmt.Errorf("docker compose down failed: %v", err1)
	}
	return nil
}

func dockerComposeUp(composeFile string) error {
	log.Printf("[Docker Compose] Starting stack: %s", composeFile)
	err1 := exec.Command("docker", "compose", "-f", composeFile, "up", "-d").Run()
	if err1 != nil {
		log.Printf("[Docker Compose] Warning: 'docker compose' failed, trying 'docker-compose': %v", err1)
		err2 := exec.Command("docker-compose", "-f", composeFile, "up", "-d").Run()
		if err2 != nil {
			return fmt.Errorf("docker compose up failed: %v", err2)
		}
	}
	return nil
}
