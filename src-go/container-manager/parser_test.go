package main

import (
	"encoding/json"
	"testing"
)

func TestParseAndNormalizeCompose(t *testing.T) {
	yamlInput := []byte(`
version: "3.8"
services:
  web:
    image: nginx:alpine
    ports:
      - "80:80"
      - 8080
    environment:
      - DEBUG=true
      - PORT=80
    volumes:
      - html_data:/usr/share/nginx/html
  db:
    image: postgres:15
    environment:
      POSTGRES_DB: mydb
      POSTGRES_USER: user
    volumes:
      - /var/lib/postgresql/data
volumes:
  html_data:
`)

	normalized, err := ParseAndNormalizeCompose(yamlInput)
	if err != nil {
		t.Fatalf("Failed to parse: %v", err)
	}

	if normalized.Version != "3.8" {
		t.Errorf("Expected version 3.8, got %s", normalized.Version)
	}

	// Verify web service
	web, ok := normalized.Services["web"]
	if !ok {
		t.Fatal("Missing web service")
	}
	if web.Image != "nginx:alpine" {
		t.Errorf("Expected nginx:alpine, got %s", web.Image)
	}
	if len(web.Ports) != 2 || web.Ports[0] != "80:80" || web.Ports[1] != "8080" {
		t.Errorf("Unexpected web ports: %v", web.Ports)
	}
	if web.Environment["DEBUG"] != "true" || web.Environment["PORT"] != "80" {
		t.Errorf("Unexpected web env: %v", web.Environment)
	}
	if len(web.Volumes) != 1 || web.Volumes[0] != "html_data:/usr/share/nginx/html" {
		t.Errorf("Unexpected web volumes: %v", web.Volumes)
	}

	// Verify db service
	db, ok := normalized.Services["db"]
	if !ok {
		t.Fatal("Missing db service")
	}
	if db.Environment["POSTGRES_DB"] != "mydb" || db.Environment["POSTGRES_USER"] != "user" {
		t.Errorf("Unexpected db env: %v", db.Environment)
	}

	// Verify volumes list
	if len(normalized.Volumes) != 1 || normalized.Volumes[0] != "html_data" {
		t.Errorf("Unexpected volumes list: %v", normalized.Volumes)
	}

	// Dump JSON to log
	js, _ := json.MarshalIndent(normalized, "", "  ")
	t.Logf("Normalized JSON output:\n%s", string(js))
}
