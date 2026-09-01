package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"html/template"
	"net/http"
	"os"
	"strings"

	"github.com/SebastiaanKlippert/go-wkhtmltopdf"
)

func parseTags(val string) []string {
	if val == "" {
		return nil
	}
	parts := strings.Split(val, ",")
	var res []string
	for _, p := range parts {
		trimmed := strings.TrimSpace(p)
		if trimmed != "" {
			res = append(res, trimmed)
		}
	}
	return res
}

func generatePDFHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var filterReq CVFilterRequest

	if r.Method == http.MethodPost {
		// Try to decode JSON payload
		contentType := r.Header.Get("Content-Type")
		if strings.Contains(contentType, "application/json") {
			err := json.NewDecoder(r.Body).Decode(&filterReq)
			if err != nil {
				http.Error(w, fmt.Sprintf("Error parsing JSON: %v", err), http.StatusBadRequest)
				return
			}
		} else {
			// Fallback to query params if not JSON
			filterReq.GeneralTags = parseTags(r.URL.Query().Get("tags"))
			filterReq.ProjectTags = parseTags(r.URL.Query().Get("project_tags"))
			filterReq.SkillTags = parseTags(r.URL.Query().Get("skill_tags"))
			filterReq.ExperienceTags = parseTags(r.URL.Query().Get("experience_tags"))
			filterReq.SummaryTags = parseTags(r.URL.Query().Get("summary_tags"))
		}
	} else {
		// GET request: parse from query parameters
		filterReq.GeneralTags = parseTags(r.URL.Query().Get("tags"))
		filterReq.ProjectTags = parseTags(r.URL.Query().Get("project_tags"))
		filterReq.SkillTags = parseTags(r.URL.Query().Get("skill_tags"))
		filterReq.ExperienceTags = parseTags(r.URL.Query().Get("experience_tags"))
		filterReq.SummaryTags = parseTags(r.URL.Query().Get("summary_tags"))
	}

	// Filter the CV data based on tags
	cvData := FilterCV(filterReq)

	// HTML template path
	templatePath := "templates/sample.html"

	// Parse template
	t, err := template.New("sample.html").Funcs(template.FuncMap{
		"join": func(items []string, sep string) string {
			return strings.Join(items, sep)
		},
	}).ParseFiles(templatePath)
	if err != nil {
		http.Error(w, fmt.Sprintf("Error parsing template: %v", err), http.StatusInternalServerError)
		return
	}

	var buf bytes.Buffer
	if err := t.Execute(&buf, cvData); err != nil {
		http.Error(w, fmt.Sprintf("Error executing template: %v", err), http.StatusInternalServerError)
		return
	}

	// Generate PDF
	pdfg, err := wkhtmltopdf.NewPDFGenerator()
	if err != nil {
		http.Error(w, fmt.Sprintf("Error creating PDF generator: %v", err), http.StatusInternalServerError)
		return
	}

	// Customize arguments
	pdfg.NoPdfCompression.Set(true)
	pdfg.PageSize.Set(wkhtmltopdf.PageSizeA4)
	pdfg.Dpi.Set(300)

	// Add page from template content buffer
	pdfg.AddPage(wkhtmltopdf.NewPageReader(&buf))

	// Create the PDF document
	if err := pdfg.Create(); err != nil {
		http.Error(w, fmt.Sprintf("Error generating PDF: %v", err), http.StatusInternalServerError)
		return
	}

	pdfBytes := pdfg.Bytes()
	if len(pdfBytes) == 0 {
		http.Error(w, "Generated PDF is empty", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", "inline; filename=\"cv.pdf\"")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(pdfBytes)))
	w.Write(pdfBytes)
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8082"
	}

	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	http.HandleFunc("/generate", generatePDFHandler)
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		generatePDFHandler(w, r)
	})

	fmt.Printf("CV Generator API Server running on port %s...\n", port)
	fmt.Printf("Access via: http://localhost:%s/generate?tags=golang\n", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		fmt.Printf("Error starting server: %v\n", err)
	}
}
