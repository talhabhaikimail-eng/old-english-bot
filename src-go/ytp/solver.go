package main

// n / sig solver without Node. Port of yt-dlp EJS (Unlicense, github.com/yt-dlp/ejs) on goja (pure Go JS).
//
// EJS parses the player with meriyah inside a JS runtime (57 s on goja). Here the same rewrite is done in Go
// with goja's parser (~0.5 s) by slicing source text, then the script is SLIMMED to the top-level statements
// the URL-signing function transitively references (goja compile time is ~proportional to script size).
// The slim script is verified against the full one on real challenges before it is cached.

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/dop251/goja"
	"github.com/dop251/goja/ast"
	"github.com/dop251/goja/parser"
)

const envShim = `if (typeof globalThis.XMLHttpRequest === "undefined") { globalThis.XMLHttpRequest = { prototype: {} }; }
if (typeof URL === "undefined") {
  globalThis.location = { hash: "", host: "www.youtube.com", hostname: "www.youtube.com",
    href: "https://www.youtube.com/watch?v=yt-dlp-wins", origin: "https://www.youtube.com", password: "",
    pathname: "/watch", port: "", protocol: "https:", search: "?v=yt-dlp-wins", username: "" };
} else { globalThis.location = new URL("https://www.youtube.com/watch?v=yt-dlp-wins"); }
if (typeof globalThis.document === "undefined") { globalThis.document = Object.create(null); }
if (typeof globalThis.navigator === "undefined") { globalThis.navigator = Object.create(null); }
if (typeof globalThis.self === "undefined") { globalThis.self = globalThis; }
if (typeof globalThis.window === "undefined") { globalThis.window = globalThis; }
`

// wrapper around the player's URL-builder function F (EJS core `a()`)
const wrapTmpl = `(({sig, n}) => {
  const url = (%s)("https://youtube.com/watch?v=yt-dlp-wins", "s", sig ? encodeURIComponent(sig) : undefined);
  url.set("n", n);
  const proto = Object.getPrototypeOf(url);
  const keys = Object.keys(proto).concat(Object.getOwnPropertyNames(proto));
  for (const key of keys) {
    if (!["constructor", "set", "get", "clone"].includes(key)) { url[key](); break; }
  }
  const s = url.get("s");
  return { sig: s ? decodeURIComponent(s) : null, n: url.get("n") ?? null };
})`

// EJS core `f()`: run every candidate, require exactly one distinct answer
const pickTmpl = `((_input) => {
  const _results = new Set(); const errors = [];
  for (const _generator of [%s]) { try { _results.add(_generator(_input)); } catch (e) { errors.push(e); } }
  if (!_results.size) { throw ` + "`no solutions: ${errors.join(\", \")}`" + `; }
  if (_results.size !== 1) { throw ` + "`invalid solutions: ${[..._results].map(x => JSON.stringify(x)).join(\", \")}`" + `; }
  return _results.values().next().value;
})`

type stmt struct {
	src     string
	defines []string // names this statement declares or augments (root of assignment target)
	always  bool     // not a plain declaration/assignment -> keep unconditionally
}

// refs returns the identifiers a piece of JS may reference: every identifier token that is not inside a
// string, template text, comment or regex literal, and not a property name after '.'. A lexing mistake can
// only add names (bigger script) or drop some (caught by the full-vs-slim check in solve()).
func refs(s string) []string {
	var out []string
	isID := func(c byte) bool {
		return c == '_' || c == '$' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
	}
	prev := byte(0) // last significant char
	prevWord := ""  // last identifier/keyword, for regex detection after return/typeof/...
	for i := 0; i < len(s); {
		c := s[i]
		switch {
		case c == ' ' || c == '\n' || c == '\t' || c == '\r':
			i++
			continue
		case c == '"' || c == '\'' || c == '`':
			i++
			for i < len(s) && s[i] != c {
				if s[i] == '\\' {
					i++
				} else if c == '`' && s[i] == '$' && i+1 < len(s) && s[i+1] == '{' {
					// ${expr}: scan the expression as code (approximate: up to the matching brace)
					depth, j := 1, i+2
					for j < len(s) && depth > 0 {
						if s[j] == '{' {
							depth++
						} else if s[j] == '}' {
							depth--
						}
						j++
					}
					out = append(out, refs(s[i+2:j-1])...)
					i = j
					continue
				}
				i++
			}
			i++
			prev, prevWord = '"', ""
			continue
		case c == '/' && i+1 < len(s) && s[i+1] == '/':
			for i < len(s) && s[i] != '\n' {
				i++
			}
			continue
		case c == '/' && i+1 < len(s) && s[i+1] == '*':
			if j := strings.Index(s[i+2:], "*/"); j >= 0 {
				i += j + 4
			} else {
				i = len(s)
			}
			continue
		case c == '/' && (prev == 0 || strings.IndexByte("(,=:[!&|?{};+-*%<>~^", prev) >= 0 ||
			prevWord == "return" || prevWord == "typeof" || prevWord == "case" || prevWord == "in" ||
			prevWord == "of" || prevWord == "new" || prevWord == "delete" || prevWord == "void" || prevWord == "throw"):
			i++ // regex literal
			inClass := false
			for i < len(s) && (s[i] != '/' || inClass) && s[i] != '\n' {
				if s[i] == '\\' {
					i++
				} else if s[i] == '[' {
					inClass = true
				} else if s[i] == ']' {
					inClass = false
				}
				i++
			}
			i++
			for i < len(s) && isID(s[i]) { // flags
				i++
			}
			prev, prevWord = '"', ""
			continue
		case isID(c) && !(c >= '0' && c <= '9'):
			j := i
			for j < len(s) && isID(s[j]) {
				j++
			}
			w := s[i:j]
			dot := prev == '.' && !(i >= 3 && s[i-3:i] == "...")
			if !dot {
				out = append(out, w)
			}
			prev, prevWord = 'a', w
			i = j
			continue
		case c >= '0' && c <= '9':
			for i < len(s) && (isID(s[i]) || s[i] == '.') {
				i++
			}
			prev, prevWord = '0', ""
			continue
		}
		prev, prevWord = c, ""
		i++
	}
	return out
}

// preprocess rewrites the raw player into the solver script body (run as Function("_result", body)).
// Returns the full script and the slimmed one.
func preprocess(player string) (full, slim string, err error) {
	prog, err := parser.ParseFile(nil, "player.js", player, 0)
	if err != nil {
		return "", "", fmt.Errorf("parse player: %w", err)
	}
	src := func(n ast.Node) string { return player[int(n.Idx0())-1 : int(n.Idx1())-1] } // ok for idents/member exprs

	body, end, err := playerBody(prog)
	if err != nil {
		return "", "", err
	}
	// goja's end positions skip closing parens, so a statement's text is cut from its start to the next
	// statement's start (keeps separators and parens). Starts are moved back over a leading '('.
	starts := make([]int, len(body)+1)
	for i, s := range body {
		starts[i] = backOverParens(player, int(s.Idx0())-1)
	}
	starts[len(body)] = end
	var stmts []stmt
	var cands []string // source of the function reference (identifier or member expression)
	for i, s := range body {
		text := strings.TrimSpace(player[starts[i]:starts[i+1]])
		switch s := s.(type) {
		case *ast.ExpressionStatement:
			switch e := s.Expression.(type) {
			case *ast.AssignExpression:
				st := stmt{src: terminate(text)}
				if r := rootIdent(e.Left); r != "" {
					st.defines = []string{r}
				} else {
					st.always = true
				}
				stmts = append(stmts, st)
				if fn, ok := e.Right.(*ast.FunctionLiteral); ok && !fn.Async && isURLBuilder(fn) {
					cands = append(cands, src(e.Left))
				}
			case *ast.StringLiteral, *ast.NumberLiteral, *ast.BooleanLiteral, *ast.NullLiteral, *ast.RegExpLiteral:
				stmts = append(stmts, stmt{src: terminate(text), always: true})
			} // other expression statements are dropped (EJS does the same)
		case *ast.FunctionDeclaration:
			stmts = append(stmts, stmt{src: text, defines: []string{s.Function.Name.Name.String()}})
			if !s.Function.Async && isURLBuilder(s.Function) {
				cands = append(cands, s.Function.Name.Name.String())
			}
		case *ast.VariableStatement:
			stmts = append(stmts, splitBindings(player, "var", s.List, starts[i+1], &cands)...)
		case *ast.LexicalDeclaration:
			stmts = append(stmts, splitBindings(player, s.Token.String(), s.List, starts[i+1], &cands)...)
		default:
			stmts = append(stmts, stmt{src: terminate(text), always: true})
		}
	}
	if len(cands) == 0 {
		return "", "", errors.New("solver: URL builder function not found in player")
	}
	var nGen, sGen []string
	for _, c := range cands {
		w := fmt.Sprintf(wrapTmpl, c)
		nGen = append(nGen, "(n) => "+w+"({n}).n")
		sGen = append(sGen, "(sig) => "+w+"({sig}).sig")
	}
	tail := "\n_result.n = " + fmt.Sprintf(pickTmpl, strings.Join(nGen, ",")) +
		";\n_result.sig = " + fmt.Sprintf(pickTmpl, strings.Join(sGen, ",")) + ";\n"

	var fb strings.Builder
	fb.WriteString(envShim)
	for _, s := range stmts {
		fb.WriteString(s.src)
		fb.WriteByte('\n')
	}
	full = fb.String() + tail

	// slim: keep statements reachable from the candidates (+ every "always" statement).
	// References are over-approximated by every identifier-like token, which is safe (keeps more, never less).
	byName := map[string][]int{}
	for i, s := range stmts {
		for _, d := range s.defines {
			byName[d] = append(byName[d], i)
		}
	}
	keep := make([]bool, len(stmts))
	var queue []int
	seen := map[string]bool{}
	need := func(text string) {
		for _, id := range refs(text) {
			if seen[id] {
				continue
			}
			seen[id] = true
			for _, i := range byName[id] {
				if !keep[i] {
					keep[i] = true
					queue = append(queue, i)
				}
			}
		}
	}
	for i, s := range stmts {
		if s.always {
			keep[i] = true
			queue = append(queue, i)
		}
	}
	need(strings.Join(cands, " "))
	for len(queue) > 0 {
		i := queue[0]
		queue = queue[1:]
		need(stmts[i].src)
	}
	var sb strings.Builder
	sb.WriteString(envShim)
	for i, s := range stmts {
		if keep[i] {
			sb.WriteString(s.src)
			sb.WriteByte('\n')
		}
	}
	slim = sb.String() + tail
	return full, slim, nil
}

// playerBody returns the statements inside the player's wrapping IIFE (EJS core `u()`).
func playerBody(prog *ast.Program) ([]ast.Statement, int, error) {
	var fn *ast.FunctionLiteral
	switch len(prog.Body) {
	case 1: // (function(){...}).call(this)
		if es, ok := prog.Body[0].(*ast.ExpressionStatement); ok {
			if ce, ok := es.Expression.(*ast.CallExpression); ok {
				if de, ok := ce.Callee.(*ast.DotExpression); ok {
					fn, _ = de.Left.(*ast.FunctionLiteral)
				}
			}
		}
		if fn != nil {
			return fn.Body.List, int(fn.Body.RightBrace) - 1, nil
		}
	case 2: // var _yt_player={}; (function(g){...})(_yt_player)  -> drop the first inner statement
		if es, ok := prog.Body[1].(*ast.ExpressionStatement); ok {
			if ce, ok := es.Expression.(*ast.CallExpression); ok {
				fn, _ = ce.Callee.(*ast.FunctionLiteral)
			}
		}
		if fn != nil && len(fn.Body.List) > 0 {
			return fn.Body.List[1:], int(fn.Body.RightBrace) - 1, nil
		}
	}
	return nil, 0, errors.New("solver: unexpected player structure")
}

// isURLBuilder: body contains a statement `x.y("alr", "yes")`.
func isURLBuilder(fn *ast.FunctionLiteral) bool {
	if fn == nil || fn.Body == nil {
		return false
	}
	for _, s := range fn.Body.List {
		es, ok := s.(*ast.ExpressionStatement)
		if !ok {
			continue
		}
		ce, ok := es.Expression.(*ast.CallExpression)
		if !ok || len(ce.ArgumentList) != 2 {
			continue
		}
		de, ok := ce.Callee.(*ast.DotExpression)
		if !ok {
			continue
		}
		if _, ok := de.Left.(*ast.Identifier); !ok {
			continue
		}
		a, ok1 := ce.ArgumentList[0].(*ast.StringLiteral)
		b, ok2 := ce.ArgumentList[1].(*ast.StringLiteral)
		if ok1 && ok2 && a.Value.String() == "alr" && b.Value.String() == "yes" {
			return true
		}
	}
	return false
}

// splitBindings turns `var a=1,b=2` into `var a=1;` `var b=2;` so each name can be kept independently.
// Each binding's text runs from its identifier to the next binding's identifier (minus the comma).
func splitBindings(player, kw string, list []*ast.Binding, stmtEnd int, cands *[]string) []stmt {
	var out []stmt
	for i, b := range list {
		end := stmtEnd
		if i+1 < len(list) {
			end = backOverParens(player, int(list[i+1].Target.Idx0())-1)
		}
		text := strings.TrimSpace(player[backOverParens(player, int(b.Target.Idx0())-1):end])
		text = strings.TrimSpace(strings.TrimRight(strings.TrimSpace(text), ",;"))
		st := stmt{src: kw + " " + text + ";"}
		if id, ok := b.Target.(*ast.Identifier); ok {
			st.defines = []string{id.Name.String()}
			if fn, ok := b.Initializer.(*ast.FunctionLiteral); ok && !fn.Async && isURLBuilder(fn) {
				*cands = append(*cands, id.Name.String())
			}
		} else { // destructuring: keep unconditionally
			st.always = true
		}
		out = append(out, st)
	}
	return out
}

// backOverParens moves i back over whitespace-separated '(' that belong to the node starting at i.
func backOverParens(s string, i int) int {
	j := i
	for j > 0 {
		c := s[j-1]
		if c == '(' {
			i = j - 1
		} else if !strings.ContainsRune(" \n\t\r", rune(c)) {
			break
		}
		j--
	}
	return i
}

// terminate makes sure a statement's text ends with ';' (the next statement's text follows it).
func terminate(t string) string {
	if strings.HasSuffix(t, ";") {
		return t
	}
	return t + ";"
}

func rootIdent(e ast.Expression) string {
	for {
		switch x := e.(type) {
		case *ast.Identifier:
			return x.Name.String()
		case *ast.DotExpression:
			e = x.Left
		case *ast.BracketExpression:
			e = x.Left
		default:
			return ""
		}
	}
}

// ---------------------------------------------------------------- runtime

type jsSolver struct {
	mu  sync.Mutex
	vm  *goja.Runtime
	n   goja.Callable
	sig goja.Callable
}

func newJSSolver(script string) (*jsSolver, error) {
	prog, err := goja.Compile("solver.js", "(function(_result){\n"+script+"\n})", false)
	if err != nil {
		return nil, err
	}
	vm := goja.New()
	f, err := vm.RunProgram(prog)
	if err != nil {
		return nil, err
	}
	fn, _ := goja.AssertFunction(f)
	res := vm.NewObject()
	if _, err := fn(nil, res); err != nil {
		return nil, fmt.Errorf("solver init: %w", err)
	}
	s := &jsSolver{vm: vm}
	s.n, _ = goja.AssertFunction(res.Get("n"))
	s.sig, _ = goja.AssertFunction(res.Get("sig"))
	if s.n == nil || s.sig == nil {
		return nil, errors.New("solver: n/sig function missing")
	}
	return s, nil
}

func (s *jsSolver) solve(ns, sigs []string) (map[string]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string]string{}
	for _, list := range []struct {
		f  goja.Callable
		cs []string
	}{{s.n, ns}, {s.sig, sigs}} {
		for _, c := range list.cs {
			v, err := list.f(nil, s.vm.ToValue(c))
			if err != nil {
				return nil, fmt.Errorf("solve %.12s: %w", c, err)
			}
			if goja.IsNull(v) || goja.IsUndefined(v) {
				return nil, fmt.Errorf("solve %.12s: no answer", c)
			}
			out[c] = v.String()
		}
	}
	return out, nil
}

var (
	solversMu sync.Mutex
	solvers   = map[string]*jsSolver{} // player id -> warm solver (server mode reuses it)
)

// solve answers n and sig challenges for player pid. The script is built once per player version and cached
// on disk as <pid>.solver.js; the compiled solver is kept in memory for the life of the process.
func solve(pid string, ns, sigs []string) (map[string]string, error) {
	if len(ns)+len(sigs) == 0 {
		return map[string]string{}, nil
	}
	solversMu.Lock()
	defer solversMu.Unlock()
	if s := solvers[pid]; s != nil {
		return s.solve(ns, sigs)
	}
	cached := filepath.Join(cacheDir, pid+".solver.js")
	if b, err := os.ReadFile(cached); err == nil {
		if s, err := newJSSolver(string(b)); err == nil {
			solvers[pid] = s
			return s.solve(ns, sigs)
		}
	}
	raw, err := os.ReadFile(filepath.Join(cacheDir, pid+".tv.js"))
	if err != nil {
		return nil, err
	}
	full, slim, err := preprocess(string(raw))
	if err != nil {
		return nil, err
	}
	// verify the slim script against the full one on these challenges plus fixed n and sig probes,
	// so both functions are always checked even when the caller only asked for one kind
	vn, vs := append([]string{probeN}, ns...), append([]string{probeSig}, sigs...)
	fs, err := newJSSolver(full)
	if err != nil {
		return nil, err
	}
	want, err := fs.solve(vn, vs)
	if err != nil {
		return nil, err
	}
	use, script := fs, full
	if ss, err := newJSSolver(slim); err == nil {
		if got, err := ss.solve(vn, vs); err == nil && equalMaps(got, want) {
			use, script = ss, slim
		}
	}
	if script == full {
		debugf("solver: slim script disagreed with full player, using full (%d KiB)", len(full)>>10)
	} else {
		debugf("solver: slim script %d KiB (full %d KiB)", len(slim)>>10, len(full)>>10)
	}
	_ = os.WriteFile(cached, []byte(script), 0o644)
	solvers[pid] = use
	return want, nil
}

// probe challenges with realistic shapes (n ~ 15 chars, sig ~ 108 chars)
const (
	probeN   = "aB3dE5fG7hI9jK1"
	probeSig = "AOq0QJ8wRgIhAKy3vN5x2pY7mT1cB9dF4gH6jL8kM0nP2qR4sT6uV8wX0yZ2AiEA1bC3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC9dE1fG3=="
)

func equalMaps(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}
