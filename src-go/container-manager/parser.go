package main

import (
	"errors"
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// RawServiceConfig handles the flexible nature of YAML fields in compose
type RawServiceConfig struct {
	Image       string            `yaml:"image,omitempty"`
	Ports       []interface{}     `yaml:"ports,omitempty"`
	Environment interface{}       `yaml:"environment,omitempty"`
	Volumes     []interface{}     `yaml:"volumes,omitempty"`
	Labels      map[string]string `yaml:"labels,omitempty"`
}

type RawComposeConfig struct {
	Version  string                       `yaml:"version"`
	Services map[string]RawServiceConfig   `yaml:"services"`
	Volumes  map[string]interface{}       `yaml:"volumes,omitempty"`
}

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

// ParseAndNormalizeCompose parses raw compose yaml and normalizes the fields
func ParseAndNormalizeCompose(yamlData []byte) (*NormalizedComposeConfig, error) {
	var raw RawComposeConfig
	if err := yaml.Unmarshal(yamlData, &raw); err != nil {
		return nil, fmt.Errorf("failed to parse YAML: %w", err)
	}

	if len(raw.Services) == 0 {
		return nil, errors.New("compose file must define at least one service")
	}

	normalized := &NormalizedComposeConfig{
		Version:  raw.Version,
		Services: make(map[string]NormalizedServiceConfig),
		Volumes:  make([]string, 0),
	}

	// Parse volumes list from raw.Volumes
	for volName := range raw.Volumes {
		normalized.Volumes = append(normalized.Volumes, volName)
	}

	for svcName, rawSvc := range raw.Services {
		normSvc := NormalizedServiceConfig{
			Image:       rawSvc.Image,
			Ports:       make([]string, 0),
			Environment: make(map[string]string),
			Volumes:     make([]string, 0),
			Labels:      rawSvc.Labels,
		}
		if normSvc.Labels == nil {
			normSvc.Labels = make(map[string]string)
		}

		// 1. Normalize Ports (can be list of strings, integers, or maps/objects)
		for _, p := range rawSvc.Ports {
			if str, ok := p.(string); ok {
				// strip /tcp or /udp suffix if present
				cleaned := strings.Split(str, "/")[0]
				normSvc.Ports = append(normSvc.Ports, cleaned)
			} else if num, ok := p.(int); ok {
				normSvc.Ports = append(normSvc.Ports, fmt.Sprintf("%d", num))
			} else if portMap, ok := p.(map[string]interface{}); ok {
				// Long-syntax: target, published, protocol, mode
				target, _ := portMap["target"].(int)
				published, _ := portMap["published"].(int)
				if published > 0 && target > 0 {
					normSvc.Ports = append(normSvc.Ports, fmt.Sprintf("%d:%d", published, target))
				} else if target > 0 {
					normSvc.Ports = append(normSvc.Ports, fmt.Sprintf("%d", target))
				}
			} else if portMap, ok := p.(map[interface{}]interface{}); ok {
				// Handle yaml.v3 mapping type which might decode as map[interface{}]interface{}
				var target, published int
				for k, v := range portMap {
					kStr := fmt.Sprintf("%v", k)
					if kStr == "target" {
						if vInt, ok := v.(int); ok {
							target = vInt
						}
					} else if kStr == "published" {
						if vInt, ok := v.(int); ok {
							published = vInt
						}
					}
				}
				if published > 0 && target > 0 {
					normSvc.Ports = append(normSvc.Ports, fmt.Sprintf("%d:%d", published, target))
				} else if target > 0 {
					normSvc.Ports = append(normSvc.Ports, fmt.Sprintf("%d", target))
				}
			} else {
				normSvc.Ports = append(normSvc.Ports, fmt.Sprintf("%v", p))
			}
		}

		// 2. Normalize Environment
		if rawSvc.Environment != nil {
			switch envVal := rawSvc.Environment.(type) {
			case map[string]interface{}:
				for k, v := range envVal {
					normSvc.Environment[k] = fmt.Sprintf("%v", v)
				}
			case []interface{}:
				for _, item := range envVal {
					if itemStr, ok := item.(string); ok {
						parts := strings.SplitN(itemStr, "=", 2)
						if len(parts) == 2 {
							normSvc.Environment[parts[0]] = parts[1]
						} else if len(parts) == 1 {
							normSvc.Environment[parts[0]] = ""
						}
					}
				}
			}
		}

		// 3. Normalize Volumes
		for _, v := range rawSvc.Volumes {
			if str, ok := v.(string); ok {
				normSvc.Volumes = append(normSvc.Volumes, str)
			} else {
				normSvc.Volumes = append(normSvc.Volumes, fmt.Sprintf("%v", v))
			}
		}

		normalized.Services[svcName] = normSvc
	}

	return normalized, nil
}
