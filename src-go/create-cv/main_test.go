package main

import (
	"bytes"
	"html/template"
	"strings"
	"testing"
)

func TestTagsMatch(t *testing.T) {
	tests := []struct {
		itemTags []string
		search   []string
		expected bool
	}{
		{[]string{"golang", "backend"}, []string{"golang"}, true},
		{[]string{"golang", "backend"}, []string{"react"}, false},
		{[]string{"all"}, []string{"react"}, true},
		{[]string{"golang"}, []string{"GOLANG"}, true},
		{[]string{"Next.js"}, []string{"nextjs"}, true},
	}

	for _, tc := range tests {
		res := tagsMatch(tc.itemTags, tc.search)
		if res != tc.expected {
			t.Errorf("tagsMatch(%v, %v) = %v; expected %v", tc.itemTags, tc.search, res, tc.expected)
		}
	}
}

func TestFilterCV(t *testing.T) {
	req := CVFilterRequest{
		GeneralTags: []string{"golang"},
	}
	cv := FilterCV(req)

	hasGoProject := false
	for _, p := range cv.Projects {
		if strings.Contains(strings.ToLower(p.Title), "golang") || strings.Contains(strings.ToLower(p.Title), "assistant") {
			hasGoProject = true
		}
	}
	if !hasGoProject {
		t.Errorf("Expected filtered CV to contain Go/CLI projects when general tag is golang")
	}
}

func TestTemplateParsing(t *testing.T) {
	templatePath := "templates/sample.html"
	tmpl, err := template.New("sample.html").Funcs(template.FuncMap{
		"join": func(items []string, sep string) string {
			return strings.Join(items, sep)
		},
	}).ParseFiles(templatePath)
	if err != nil {
		t.Fatalf("Failed to parse template: %v", err)
	}

	cv := FilterCV(CVFilterRequest{GeneralTags: []string{"golang"}})
	var buf bytes.Buffer
	err = tmpl.Execute(&buf, cv)
	if err != nil {
		t.Fatalf("Failed to execute template: %v", err)
	}

	if buf.Len() == 0 {
		t.Errorf("Expected template output to be non-empty")
	}
}
