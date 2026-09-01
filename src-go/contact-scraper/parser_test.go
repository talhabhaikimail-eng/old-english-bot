package main

import (
	"reflect"
	"testing"
)

func TestExtractEmails(t *testing.T) {
	input := `
		Please contact us at info@example.com or support@example.com for help.
		You can also reach our CEO, Jane Doe, at jane.doe@example.com or marketing@example.com.
		Invalid emails: not-an-email, test@, @domain.com.
		Valid user: alice_smith123@sub.domain.co.uk.
	`
	// Target domain is example.com, so info@example.com, jane.doe@example.com, and marketing@example.com are kept!
	// alice_smith123@sub.domain.co.uk is also kept because it's not a placeholder prefix, not a placeholder domain, and not a role-based prefix.
	expected := []string{"info@example.com", "support@example.com", "jane.doe@example.com", "marketing@example.com", "alice_smith123@sub.domain.co.uk"}
	results := ExtractEmails(input, "example.com")

	if !reflect.DeepEqual(results, expected) {
		t.Errorf("Expected %v, got %v", expected, results)
	}
}

func TestExtractEmailsExternal(t *testing.T) {
	input := `
		Please contact us at info@example.com or support@example.com for help.
		You can also reach our CEO, Jane Doe, at jane.doe@example.com or marketing@example.com.
		Valid user: alice_smith123@sub.domain.co.uk.
	`
	// Target domain is anothercompany.com.
	// Since example.com is a placeholder domain, info@example.com, support@example.com, jane.doe@example.com, and marketing@example.com are filtered out!
	// alice_smith123@sub.domain.co.uk is kept because it is on sub.domain.co.uk (not a placeholder domain, and prefix is not a role-based prefix).
	expected := []string{"alice_smith123@sub.domain.co.uk"}
	results := ExtractEmails(input, "anothercompany.com")

	if !reflect.DeepEqual(results, expected) {
		t.Errorf("Expected %v, got %v", expected, results)
	}
}

func TestExtractPhones(t *testing.T) {
	input := `
		Call us at +1-555-0199 or (555) 555-0188.
		Office line: +44 20 7946 0958.
		Not a phone: 12345, 12, abc-defg.
	`
	expected := []string{"+1-555-0199", "(555) 555-0188", "+44 20 7946 0958"}
	results := ExtractPhones(input)

	if !reflect.DeepEqual(results, expected) {
		t.Errorf("Expected %v, got %v", expected, results)
	}
}

func TestExtractSocials(t *testing.T) {
	hrefs := []string{
		"https://example.com/about",
		"https://www.linkedin.com/company/example-corp",
		"https://facebook.com/example-corp",
		"https://twitter.com/example_corp",
		"https://x.com/example_corp_new", // Should pick first or match twitter
		"https://youtube.com/@examplecorp",
		"https://github.com/examplecorp",
	}

	expected := map[string]string{
		"linkedin":  "https://www.linkedin.com/company/example-corp",
		"facebook":  "https://facebook.com/example-corp",
		"twitter":   "https://twitter.com/example_corp",
		"youtube":   "https://youtube.com/@examplecorp",
		"github":    "https://github.com/examplecorp",
	}

	results := ExtractSocials(hrefs)

	for k, v := range expected {
		if got, exists := results[k]; !exists || got != v {
			t.Errorf("For key %s: expected %s, got %s", k, v, got)
		}
	}
}
