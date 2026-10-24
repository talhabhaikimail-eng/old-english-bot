package main

import "testing"

func TestParseImageRef(t *testing.T) {
	cases := []struct{ in, repo, tag string }{
		{"nginx", "nginx", "latest"},
		{"nginx:1.25", "nginx", "1.25"},
		{"docker.io/library/nginx:alpine", "nginx", "alpine"},
		{"ghcr.io/Owner/App:v2", "ghcr.io/owner/app", "v2"},
		{"localhost:5000/app", "localhost:5000/app", "latest"},
		{"user/app@sha256:abc", "user/app", "latest"},
	}
	for _, c := range cases {
		repo, tag := parseImageRef(c.in)
		if repo != c.repo || tag != c.tag {
			t.Errorf("parseImageRef(%q) = %q,%q want %q,%q", c.in, repo, tag, c.repo, c.tag)
		}
	}
}

func TestSafeEqual(t *testing.T) {
	if safeEqual("", "") || safeEqual("a", "") || !safeEqual("tok", "tok") || safeEqual("tok", "tom") {
		t.Fatal("safeEqual misbehaves")
	}
}
