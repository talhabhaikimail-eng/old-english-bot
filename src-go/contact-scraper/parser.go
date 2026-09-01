package main

import (
	"regexp"
	"strings"
)

// List of placeholder domains to ignore completely
var placeholderDomains = map[string]bool{
	"example.com":     true,
	"domain.com":      true,
	"yourdomain.com":  true,
	"email.com":       true,
	"test.com":        true,
	"website.com":     true,
	"company.com":     true,
	"yourcompany.com": true,
	"temp.com":        true,
	"sample.com":      true,
}

// Platform/boileplate service domains to ignore
var platformDomains = map[string]bool{
	"shopify.com":     true,
	"wix.com":         true,
	"squarespace.com": true,
	"wordpress.org":   true,
	"wordpress.com":   true,
	"github.com":      true,
	"cloudflare.com":  true,
	"sentry.io":       true,
	"stripe.com":      true,
	"google.com":      true,
	"facebook.com":    true,
	"twitter.com":     true,
	"instagram.com":   true,
}

// Generic email prefixes representing literal placeholders
var placeholderPrefixes = map[string]bool{
	"email":    true,
	"yourname": true,
	"name":     true,
	"user":     true,
	"test":     true,
	"xyz":      true,
}

// Public email provider domains
var publicEmailProviders = map[string]bool{
	"gmail.com":   true,
	"yahoo.com":   true,
	"hotmail.com": true,
	"outlook.com": true,
	"aol.com":     true,
	"live.com":    true,
	"mail.com":    true,
	"msn.com":     true,
	"icloud.com":  true,
}

// Role-based prefixes to ignore on public hosts or external third-party domains
var roleBasedPrefixes = map[string]bool{
	"info":            true,
	"support":         true,
	"sales":           true,
	"contact":         true,
	"admin":           true,
	"jobs":            true,
	"careers":         true,
	"billing":         true,
	"help":            true,
	"office":          true,
	"hello":           true,
	"team":            true,
	"marketing":       true,
	"enquiries":       true,
	"noreply":         true,
	"no-reply":        true,
	"feedback":        true,
	"privacy":         true,
	"security":        true,
	"press":           true,
	"media":           true,
	"webmaster":       true,
	"hostmaster":      true,
	"postmaster":      true,
	"hr":              true,
	"customerservice": true,
	"service":         true,
	"account":         true,
	"accounts":        true,
	"staff":           true,
	"general":         true,
	"join":            true,
	"work":            true,
}

// Regex patterns
var (
	emailRegex = regexp.MustCompile(`[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}`)
	// Matches numbers like +1-555-555-5555, (555) 555-5555, +44 20 7946 0958, etc.
	phoneRegex = regexp.MustCompile(`\+?\(?[0-9]{1,4}\)?[-.\s]?[0-9]{1,4}[-.\s]?[0-9]{2,4}([-.\s]?[0-9]{2,6})?`)
)

// ExtractEmails finds all emails in a text, filters generic placeholders, and returns unique ones.
func ExtractEmails(text string, targetDomain string) []string {
	matches := emailRegex.FindAllString(text, -1)
	uniqueEmails := make(map[string]bool)
	var results []string

	cleanTarget := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(targetDomain)), "www.")

	for _, m := range matches {
		email := strings.ToLower(strings.TrimSpace(m))
		if email == "" {
			continue
		}

		parts := strings.Split(email, "@")
		if len(parts) != 2 {
			continue
		}
		prefix := parts[0]
		domain := parts[1]

		cleanEmailDom := strings.TrimPrefix(domain, "www.")

		// 1. Filter out literal placeholder prefixes (like email@, yourname@)
		if placeholderPrefixes[prefix] {
			continue
		}

		// 2. Filter out known placeholder domains (like example.com) unless it is our target domain
		if placeholderDomains[cleanEmailDom] && cleanEmailDom != cleanTarget {
			continue
		}

		// 3. Filter out platform domains unless it is our target domain
		if platformDomains[cleanEmailDom] && cleanEmailDom != cleanTarget {
			continue
		}

		// 4. Filter out role-based prefixes (like info@) on public email providers, platform domains, and placeholder domains unless it is our target domain
		if roleBasedPrefixes[prefix] && (publicEmailProviders[cleanEmailDom] || platformDomains[cleanEmailDom] || placeholderDomains[cleanEmailDom]) && cleanEmailDom != cleanTarget {
			continue
		}

		if !uniqueEmails[email] {
			uniqueEmails[email] = true
			results = append(results, email)
		}
	}
	return results
}

// ExtractPhones finds possible phone numbers in a text and returns unique ones.
func ExtractPhones(text string) []string {
	matches := phoneRegex.FindAllString(text, -1)
	uniquePhones := make(map[string]bool)
	var results []string

	for _, m := range matches {
		phone := strings.TrimSpace(m)
		// Clean phone number from whitespace/formatting to count digits
		clean := cleanPhoneNumber(phone)
		// A phone number should generally have between 7 and 15 digits
		if len(clean) >= 7 && len(clean) <= 15 {
			if !uniquePhones[phone] {
				uniquePhones[phone] = true
				results = append(results, phone)
			}
		}
	}
	return results
}

// cleanPhoneNumber removes non-digits (keeps + if it is at the start)
func cleanPhoneNumber(p string) string {
	var sb strings.Builder
	p = strings.TrimSpace(p)
	for i, r := range p {
		if r >= '0' && r <= '9' {
			sb.WriteRune(r)
		} else if i == 0 && r == '+' {
			sb.WriteRune(r)
		}
	}
	return sb.String()
}

// ExtractSocials resolves social links from list of HTML links found on the pages.
func ExtractSocials(hrefs []string) map[string]string {
	socials := make(map[string]string)
	socialDomains := []struct {
		key      string
		patterns []string
	}{
		{"linkedin", []string{"linkedin.com/in/", "linkedin.com/company/"}},
		{"facebook", []string{"facebook.com/", "fb.com/"}},
		{"twitter", []string{"twitter.com/", "x.com/"}},
		{"instagram", []string{"instagram.com/"}},
		{"youtube", []string{"youtube.com/channel/", "youtube.com/c/", "youtube.com/user/", "youtube.com/@"}},
		{"github", []string{"github.com/"}},
	}

	for _, href := range hrefs {
		lowerHref := strings.ToLower(href)
		for _, sd := range socialDomains {
			matched := false
			for _, pat := range sd.patterns {
				if strings.Contains(lowerHref, pat) {
					matched = true
					break
				}
			}
			if matched {
				// Don't overwrite if we already found one, or keep the cleanest
				if _, exists := socials[sd.key]; !exists {
					socials[sd.key] = href
				}
			}
		}
	}
	return socials
}
