package main

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// NormalizedServiceConfig is sent to the frontend & used internally
type NormalizedServiceConfig struct {
	Image       string            `json:"image"`
	Ports       []string          `json:"ports"`
	Environment map[string]string `json:"environment"`
	Volumes     []string          `json:"volumes"`
	Labels      map[string]string `json:"labels"`
}

type NormalizedComposeConfig struct {
	Version  string                             `json:"version"`
	Services map[string]NormalizedServiceConfig `json:"services"`
	Volumes  []string                           `json:"volumes"`
}

// ParseAndNormalizeCompose parses raw compose yaml and normalizes the fields. Compose allows several
// syntaxes for most fields (list or map env/labels, short or long ports/volumes); all are accepted.
func ParseAndNormalizeCompose(yamlData []byte) (*NormalizedComposeConfig, error) {
	var raw map[string]interface{}
	if err := yaml.Unmarshal(yamlData, &raw); err != nil {
		return nil, fmt.Errorf("failed to parse YAML: %w", err)
	}

	services, _ := raw["services"].(map[string]interface{})
	if len(services) == 0 {
		return nil, errors.New("compose file must define at least one service")
	}

	normalized := &NormalizedComposeConfig{
		Version:  envString(raw["version"]),
		Services: make(map[string]NormalizedServiceConfig),
		Volumes:  make([]string, 0),
	}

	if vols, ok := raw["volumes"].(map[string]interface{}); ok {
		for volName := range vols {
			normalized.Volumes = append(normalized.Volumes, volName)
		}
		sort.Strings(normalized.Volumes)
	}

	for svcName, rawSvc := range services {
		svc, _ := rawSvc.(map[string]interface{})
		normSvc := NormalizedServiceConfig{
			Image:       envString(svc["image"]),
			Ports:       make([]string, 0),
			Environment: make(map[string]string),
			Volumes:     make([]string, 0),
			Labels:      make(map[string]string),
		}

		// 1. Ports: strings ("8080:80/tcp"), integers, or long syntax maps
		ports, _ := svc["ports"].([]interface{})
		for _, p := range ports {
			switch v := p.(type) {
			case string:
				normSvc.Ports = append(normSvc.Ports, strings.Split(v, "/")[0])
			case map[string]interface{}:
				target, _ := toInt(v["target"])
				published, _ := toInt(v["published"])
				if published > 0 && target > 0 {
					normSvc.Ports = append(normSvc.Ports, fmt.Sprintf("%d:%d", published, target))
				} else if target > 0 {
					normSvc.Ports = append(normSvc.Ports, fmt.Sprintf("%d", target))
				}
			default:
				normSvc.Ports = append(normSvc.Ports, fmt.Sprintf("%v", v))
			}
		}

		// 2. Environment: list or map; a bare KEY (no value) shows as empty
		for k, v := range serviceEnv(svc) {
			normSvc.Environment[k] = envString(v)
		}

		// 3. Volumes: short strings or long syntax maps
		vols, _ := svc["volumes"].([]interface{})
		for _, v := range vols {
			switch t := v.(type) {
			case string:
				normSvc.Volumes = append(normSvc.Volumes, t)
			case map[string]interface{}:
				src, dst := envString(t["source"]), envString(t["target"])
				if src != "" {
					normSvc.Volumes = append(normSvc.Volumes, src+":"+dst)
				} else {
					normSvc.Volumes = append(normSvc.Volumes, dst)
				}
			default:
				normSvc.Volumes = append(normSvc.Volumes, fmt.Sprintf("%v", t))
			}
		}

		// 4. Labels: list ("a=b") or map
		switch labels := svc["labels"].(type) {
		case map[string]interface{}:
			for k, v := range labels {
				normSvc.Labels[k] = envString(v)
			}
		case []interface{}:
			for _, item := range labels {
				k, v, _ := strings.Cut(fmt.Sprint(item), "=")
				normSvc.Labels[k] = v
			}
		}

		normalized.Services[svcName] = normSvc
	}

	return normalized, nil
}
