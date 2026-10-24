package main

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func mustCompose(t *testing.T, doc string) map[string]interface{} {
	t.Helper()
	var cm map[string]interface{}
	if err := yaml.Unmarshal([]byte(doc), &cm); err != nil {
		t.Fatalf("bad yaml: %v", err)
	}
	return cm
}

func svcOf(cm map[string]interface{}, name string) map[string]interface{} {
	return cm["services"].(map[string]interface{})[name].(map[string]interface{})
}

func TestValidComposeSessionID(t *testing.T) {
	for _, id := range []string{"compose-1a2b3c4d", "compose-12345678"} {
		if !validComposeSessionID(id) {
			t.Errorf("%q should be valid", id)
		}
	}
	for _, id := range []string{"", "compose-", "compose-../../etc", "compose-1a2b/../x", "docker-1a2b3c4d", "compose-XYZ12345"} {
		if validComposeSessionID(id) {
			t.Errorf("%q should be rejected", id)
		}
	}
}

func TestMergeEnvironment(t *testing.T) {
	cm := mustCompose(t, `
services:
  web:
    image: x
    environment:
      - PASSTHROUGH
      - KEEP=1
  db:
    image: y
    environment:
      EMPTY:
      REF: ${HOST_VAR}
`)
	web := svcOf(cm, "web")
	mergeEnvironment(web, map[string]string{"PASSWORD": "a$b"})
	env := web["environment"].(map[string]interface{})
	if v, ok := env["PASSTHROUGH"]; !ok || v != nil {
		t.Errorf("bare KEY must stay a pass-through (nil), got %#v", v)
	}
	if env["KEEP"] != "1" {
		t.Errorf("KEEP lost: %#v", env["KEEP"])
	}
	if env["PASSWORD"] != "a$$b" {
		t.Errorf("override $ must be escaped, got %#v", env["PASSWORD"])
	}

	db := svcOf(cm, "db")
	mergeEnvironment(db, nil)
	env = db["environment"].(map[string]interface{})
	if env["EMPTY"] != nil {
		t.Errorf("EMPTY must stay nil, got %#v", env["EMPTY"])
	}
	if env["REF"] != "${HOST_VAR}" {
		t.Errorf("YAML interpolation must be untouched, got %#v", env["REF"])
	}
	out, _ := yaml.Marshal(cm)
	if strings.Contains(string(out), "<nil>") {
		t.Errorf("rendered YAML contains <nil>:\n%s", out)
	}
}

func TestPruneAndMaskEnv(t *testing.T) {
	cm := mustCompose(t, `
services:
  web:
    image: x
    environment:
      A: "1"
      B: ${X}
      C:
`)
	pruned := pruneEnvOverrides(cm, map[string]ServiceSetting{
		"web": {DomainMode: "quick", Env: map[string]string{"A": "1", "B": "${X}", "C": "", "D": "new", "A2": "2"}},
	})
	env := pruned["web"].Env
	if len(env) != 2 || env["D"] != "new" || env["A2"] != "2" {
		t.Errorf("only real overrides should remain, got %v", env)
	}
	if pruned["web"].DomainMode != "quick" {
		t.Errorf("non-env settings must be kept")
	}

	old := &Session{Metadata: SessionMetadata{ServiceSettings: map[string]ServiceSetting{"web": {Env: map[string]string{"SECRET": "s3cret"}}}}}
	masked := maskServiceSettings(old.Metadata.ServiceSettings)
	if masked["web"].Env["SECRET"] != maskedEnvValue {
		t.Fatalf("value not masked: %v", masked)
	}
	if old.Metadata.ServiceSettings["web"].Env["SECRET"] != "s3cret" {
		t.Fatalf("masking must not modify the stored settings")
	}
	masked["web"].Env["NEW"] = maskedEnvValue // unknown masked key is dropped
	restored := restoreMaskedEnv(masked, old)
	if restored["web"].Env["SECRET"] != "s3cret" {
		t.Errorf("masked value not restored: %v", restored)
	}
	if _, ok := restored["web"].Env["NEW"]; ok {
		t.Errorf("masked value without a stored original must be dropped")
	}
}

func TestParsePortEntry(t *testing.T) {
	cases := []struct {
		in        interface{}
		host, ctr int
		proto     string
	}{
		{"80", 0, 80, "tcp"},
		{"8080:80", 8080, 80, "tcp"},
		{"127.0.0.1:8080:80/udp", 8080, 80, "udp"},
		{"3000-3005:3000-3005", 0, 0, "tcp"},
		{8080, 0, 8080, "tcp"},
		{map[string]interface{}{"target": 80, "published": "8081"}, 8081, 80, "tcp"},
	}
	for _, c := range cases {
		e := parsePortEntry(c.in)
		if e.host != c.host || e.container != c.ctr || e.proto != c.proto {
			t.Errorf("%v: got %+v", c.in, e)
		}
	}
}

func TestPlanServicePortKeepsOtherEntries(t *testing.T) {
	cm := mustCompose(t, `
services:
  web:
    image: x
    ports:
      - "9000:9000"
      - target: 3000
        published: 3000
`)
	web := svcOf(cm, "web")
	old := &ServiceSessionMetadata{Port: 3000, HostPort: 16123}
	cport, hport, err := planServicePort("", "web", web, ServiceSetting{Port: 3000}, old)
	if err != nil {
		t.Fatal(err)
	}
	// 3000 is published but this deploy already owned 16123 for it → the managed port wins only if 3000 is taken
	if cport != 3000 || (hport != 3000 && hport != 16123) {
		t.Fatalf("got %d:%d", hport, cport)
	}
	ports := web["ports"].([]interface{})
	if len(ports) != 2 || ports[0] != "9000:9000" {
		t.Errorf("other port entries must be kept, got %v", ports)
	}

	// No ports at all: an entry is added for the exposed port
	cm = mustCompose(t, `
services:
  api:
    image: x
    expose: ["8000"]
`)
	api := svcOf(cm, "api")
	cport, hport, err = planServicePort("", "api", api, ServiceSetting{}, &ServiceSessionMetadata{Port: 8000, HostPort: 16200})
	if err != nil {
		t.Fatal(err)
	}
	if cport != 8000 || hport != 16200 {
		t.Errorf("got %d:%d", hport, cport)
	}
	if p := api["ports"].([]interface{}); len(p) != 1 || p[0] != "16200:8000" {
		t.Errorf("unexpected ports %v", p)
	}
}

func TestComposeSafety(t *testing.T) {
	bad := []string{
		"services:\n  a:\n    image: x\n    privileged: true\n",
		"services:\n  a:\n    image: x\n    network_mode: host\n",
		"services:\n  a:\n    image: x\n    pid: host\n",
		"services:\n  a:\n    image: x\n    cap_add: [SYS_ADMIN]\n",
		"services:\n  a:\n    image: x\n    volumes: [\"/var/run/docker.sock:/var/run/docker.sock\"]\n",
		"services:\n  a:\n    image: x\n    volumes: [\"/:/host\"]\n",
		"services:\n  a:\n    image: x\n    volumes: [\"/etc/shadow:/x:ro\"]\n",
		"services:\n  a:\n    image: x\n    volumes: [\"../../secrets:/x\"]\n",
		"services:\n  a:\n    image: x\n    volumes:\n      - type: bind\n        source: /root\n        target: /x\n",
		"services:\n  a:\n    image: x\n    devices: [\"/dev/sda:/dev/sda\"]\n",
		"services:\n  a:\n    image: x\nvolumes:\n  v:\n    driver_opts:\n      type: none\n      o: bind\n      device: /etc\n",
	}
	for _, doc := range bad {
		if err := validateComposeSafety(mustCompose(t, doc)); err == nil {
			t.Errorf("expected rejection for:\n%s", doc)
		}
	}
	good := "services:\n  a:\n    image: x\n    cap_add: [NET_BIND_SERVICE]\n    volumes: [\"data:/data\", \"./conf:/conf\", \"/srv/app:/app\", \"/cache\"]\nvolumes:\n  data:\n"
	if err := validateComposeSafety(mustCompose(t, good)); err != nil {
		t.Errorf("unexpected rejection: %v", err)
	}
}

func TestComposeSupport(t *testing.T) {
	if err := validateComposeSupport(mustCompose(t, "services:\n  a:\n    build: .\n")); err == nil || !strings.Contains(err.Error(), "build") {
		t.Errorf("build without image must be rejected, got %v", err)
	}
	if err := validateComposeSupport(mustCompose(t, "services:\n  a:\n    image: x\n    build: .\n")); err != nil {
		t.Errorf("build with image is allowed (build is dropped), got %v", err)
	}
	if err := validateComposeSupport(mustCompose(t, "services:\n  a:\n    image: x\n    env_file: .env\n")); err == nil {
		t.Errorf("env_file must be rejected")
	}
	if err := validateComposeSupport(mustCompose(t, "services: {}\n")); err == nil {
		t.Errorf("empty services must be rejected")
	}
}

func TestParseComposePs(t *testing.T) {
	lines := `{"ID":"abc","Service":"web","State":"running","ExitCode":0}
{"ID":"def","Service":"db","State":"exited","ExitCode":1}`
	if ps := parseComposePs(lines); len(ps) != 2 || ps[1].Service != "db" || ps[1].ExitCode != 1 {
		t.Errorf("json-lines: %+v", ps)
	}
	arr := `[{"ID":"abc","Service":"web","State":"running"}]`
	if ps := parseComposePs(arr); len(ps) != 1 || ps[0].ID != "abc" {
		t.Errorf("array: %+v", ps)
	}
}

func TestParserEdgeSyntax(t *testing.T) {
	n, err := ParseAndNormalizeCompose([]byte(`
services:
  web:
    image: x
    labels:
      - "a=b"
      - "c"
    environment:
      EMPTY:
    ports:
      - target: 80
        published: "8080"
`))
	if err != nil {
		t.Fatal(err)
	}
	web := n.Services["web"]
	if web.Labels["a"] != "b" || web.Labels["c"] != "" {
		t.Errorf("labels: %v", web.Labels)
	}
	if v, ok := web.Environment["EMPTY"]; !ok || v != "" {
		t.Errorf("EMPTY env should be empty string, got %q", v)
	}
	if len(web.Ports) != 1 || web.Ports[0] != "8080:80" {
		t.Errorf("ports: %v", web.Ports)
	}
}
