/**
 * Sample programs offered in the IDE's sample picker, grouped by language.
 *
 * The first sample of each language is a self-contained "demo test": a tiny
 * assertion harness that prints PASS/FAIL per case, a summary, and exits
 * non-zero when anything failed. It doubles as a smoke test for the runner —
 * if the harness runs and reports FAILED, the whole execution path works.
 *
 * Go samples additionally carry a `mode`: `run` compiles a `main` package,
 * `test` drives the real `go test` tool against a `*_test.go` file.
 *
 * NB: `LanguageId` is a plain `string` now. Languages come from plugin
 * manifests (`LanguageRegistry`), so a union type here would re-introduce the
 * hardcoded list the plugin architecture exists to remove. Samples are just
 * *content*; a language with no sample still works.
 */
export type LanguageId = string;
/** `project` runs a plugin-declared project step (classpath + entry class). */
export type RunMode = 'run' | 'test' | 'project';

export interface Sample {
  id: string;
  name: string;
  languageId: LanguageId;
  /** Go only; Python always runs. Markdown samples have none — nothing executes. */
  mode?: RunMode;
  code: string;
}

export interface LanguageDescriptor {
  id: LanguageId;
  displayName: string;
  /** File extension including the dot. */
  extension: string;
  /** Buffer file name inside the workspace. */
  fileName: string;
  /** True when a separate "Test" action is meaningful. */
  supportsTest: boolean;
  /**
   * True when Run actually executes something. Render-only languages have no
   * runner, so Run is disabled instead of being a button that errors.
   */
  supportsRun: boolean;
}

/**
 * A starter document for a language that ships no sample of its own — which is
 * the normal case for a user-installed plugin. It is deliberately minimal: the
 * point is that opening a brand-new language gives an empty, runnable buffer
 * instead of an empty editor that looks broken.
 */
export function starterFor(id: LanguageId): Sample {
  return {
    id: `starter-${id}`,
    name: 'Starter file',
    languageId: id,
    code: '',
  };
}

// ============================================================ Python

const PY_DEMO_TEST = `"""A tiny demo test — no dependencies, just assertions.

Press Run (Ctrl+Enter). Each check prints PASS/FAIL, then a summary line.
The exit code is non-zero when any check fails, so the status bar shows FAILED.
"""


def add(a, b):
    return a + b


def divide(a, b):
    if b == 0:
        raise ValueError("division by zero")
    return a / b


def is_palindrome(text):
    cleaned = "".join(ch.lower() for ch in text if ch.isalnum())
    return cleaned == cleaned[::-1]


# ---- a minimal test harness ----
failures = []


def check(name, got, expected):
    if got == expected:
        print(f"PASS  {name}")
    else:
        print(f"FAIL  {name}: got {got!r}, expected {expected!r}")
        failures.append(name)


print("running demo tests")
print("-" * 40)

check("add two ints", add(2, 3), 5)
check("add negatives", add(-4, -6), -10)
check("divide exact", divide(10, 2), 5.0)
check("palindrome simple", is_palindrome("racecar"), True)
check("palindrome with punctuation", is_palindrome("A man, a plan, a canal: Panama"), True)
check("not a palindrome", is_palindrome("python"), False)

# Expected failure so you can see a FAIL line and a non-zero exit code.
check("intentional failing case", add(1, 1), 3)

print("-" * 40)
if failures:
    print(f"{len(failures)} check(s) failed: {failures}")
    raise SystemExit(1)
print("all checks passed")
`;

const PY_HELLO = `"""Hello world, plus a little session state."""

print("hello from Python")

# Names defined here persist across runs in the same session (data only).
greeting = "hello"
count = 0

try:
    count
    count += 1
except NameError:
    count = 1

print(f"{greeting}, world — this session has run {count} time(s)")
`;

const PY_FIBONACCI = `"""Fibonacci three ways, with a timing comparison."""

import time


def fib_recursive(n):
    if n < 2:
        return n
    return fib_recursive(n - 1) + fib_recursive(n - 2)


def fib_iterative(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a


def fib_memo(n, _cache={}):
    if n in _cache:
        return _cache[n]
    if n < 2:
        return n
    _cache[n] = fib_memo(n - 1) + fib_memo(n - 2)
    return _cache[n]


N = 22
for name, fn in (("recursive", fib_recursive), ("iterative", fib_iterative), ("memoized", fib_memo)):
    start = time.perf_counter()
    value = fn(N)
    elapsed = (time.perf_counter() - start) * 1000
    print(f"{name:<10} fib({N}) = {value:<8} {elapsed:8.2f} ms")
`;

const PY_DATA = `"""Small data-processing example: parse, aggregate, report."""

raw = """alice,92
bob,78
carol,88
dave,64
erin,95"""

scores = {}
for line in raw.splitlines():
    name, value = line.split(",")
    scores[name] = int(value)

average = sum(scores.values()) / len(scores)
best = max(scores.items(), key=lambda kv: kv[1])
worst = min(scores.items(), key=lambda kv: kv[1])

print(f"students : {len(scores)}")
print(f"average  : {average:.1f}")
print(f"best     : {best[0]} ({best[1]})")
print(f"worst    : {worst[0]} ({worst[1]})")

print("\\nranked:")
for rank, (name, value) in enumerate(sorted(scores.items(), key=lambda kv: -kv[1]), 1):
    bar = "#" * (value // 5)
    print(f"  {rank}. {name:<6} {value:>3}  {bar}")

# Data persists for the next run in this session.
history = history + [round(average, 1)] if "history" in dir() else [round(average, 1)]
print(f"\\naverages seen this session: {history}")
`;

const PY_SESSION = `"""Session persistence demo.

Run this file twice. Values stored in the session namespace survive between
runs, so the counter and the list keep growing. Functions are NOT persisted
(they cannot be pickled across processes), so they are re-declared here.
"""

try:
    seen
except NameError:
    seen = []


def record(label):
    seen.append(label)
    return len(seen)


print("run #" + str(record("a run")))
print("history:", seen)
`;

const PY_ERROR = `"""Error handling demo — shows how failures reach the Output tab."""


def risky(divisor):
    return 100 / divisor


print("about to divide by zero...")
print(risky(0))
print("this line never runs")
`;

// ============================================================ Go

const GO_DEMO_TEST = `// A tiny demo test — no dependencies, just assertions.
//
// Press Run (Ctrl+Enter). Each check prints PASS/FAIL, then a summary line.
// The program exits non-zero when any check fails, so the status bar shows
// FAILED — the same contract as the Python demo test.
package main

import (
	"fmt"
	"os"
	"strings"
	"unicode"
)

func add(a, b int) int { return a + b }

func divide(a, b float64) (float64, error) {
	if b == 0 {
		return 0, fmt.Errorf("division by zero")
	}
	return a / b, nil
}

func isPalindrome(text string) bool {
	var b strings.Builder
	for _, r := range strings.ToLower(text) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	cleaned := []rune(b.String())
	for i, j := 0, len(cleaned)-1; i < j; i, j = i+1, j-1 {
		if cleaned[i] != cleaned[j] {
			return false
		}
	}
	return true
}

func main() {
	var failures []string

	// A tiny harness. got/want are formatted with %v so the helper works for
	// any value, not just the type it was called with.
	check := func(name string, got, want any) {
		if fmt.Sprintf("%v", got) == fmt.Sprintf("%v", want) {
			fmt.Printf("PASS  %s\\n", name)
			return
		}
		fmt.Printf("FAIL  %s: got %v, want %v\\n", name, got, want)
		failures = append(failures, name)
	}

	fmt.Println("running demo tests")
	fmt.Println(strings.Repeat("-", 40))

	check("add two ints", add(2, 3), 5)
	check("add negatives", add(-4, -6), -10)

	q, err := divide(10, 2)
	check("divide exact", q, 5)
	check("divide has no error", err, nil)

	_, err = divide(1, 0)
	check("divide by zero errors", err != nil, true)

	check("palindrome simple", isPalindrome("racecar"), true)
	check("palindrome with punctuation", isPalindrome("A man, a plan, a canal: Panama"), true)
	check("not a palindrome", isPalindrome("golang"), false)

	// Expected failure so you can see a FAIL line and a non-zero exit code.
	check("intentional failing case", add(1, 1), 3)

	fmt.Println(strings.Repeat("-", 40))
	if len(failures) > 0 {
		fmt.Printf("%d check(s) failed: %v\\n", len(failures), failures)
		os.Exit(1)
	}
	fmt.Println("all checks passed")
}
`;

const GO_TEST = `// A real Go test, driven by the Test button (go test -v).
//
// With the language set to Go, press Test. The harness is Go's own testing
// package, so failures are reported by the tool itself and the process exit
// code is 0/1 — nothing hand-rolled.
package main

import (
	"errors"
	"testing"
)

func Add(a, b int) int { return a + b }

func Divide(a, b float64) (float64, error) {
	if b == 0 {
		return 0, errors.New("division by zero")
	}
	return a / b, nil
}

func TestAdd(t *testing.T) {
	cases := []struct {
		name string
		a, b int
		want int
	}{
		{"two ints", 2, 3, 5},
		{"negatives", -4, -6, -10},
		{"zero", 0, 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Add(c.a, c.b); got != c.want {
				t.Errorf("Add(%d, %d) = %d, want %d", c.a, c.b, got, c.want)
			}
		})
	}
}

func TestDivide(t *testing.T) {
	got, err := Divide(10, 2)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != 5 {
		t.Errorf("Divide(10, 2) = %v, want 5", got)
	}

	if _, err := Divide(1, 0); err == nil {
		t.Error("Divide(1, 0) should have failed")
	}
}

func TestIntentionalFailure(t *testing.T) {
	// Remove this test to get a clean run.
	if got := Add(1, 1); got != 3 {
		t.Errorf("Add(1, 1) = %d, want 3", got)
	}
}
`;

const GO_HELLO = `// Hello world, plus a few language basics.
package main

import (
	"fmt"
	"runtime"
	"time"
)

func main() {
	fmt.Println("hello from Go")

	// The toolchain that ran this is reported in the status bar too.
	fmt.Printf("go %s on %s/%s\\n", runtime.Version(), runtime.GOOS, runtime.GOARCH)

	start := time.Now()
	total := 0
	for i := 1; i <= 1_000_000; i++ {
		total += i
	}
	fmt.Printf("sum 1..1e6 = %d  (%v)\\n", total, time.Since(start).Round(time.Microsecond))
}
`;

const GO_CONCURRENCY = `// Goroutines and channels: a worker pool plus fan-in.
package main

import (
	"fmt"
	"sync"
	"time"
)

// fanIn merges several channels into one.
func fanIn(chans ...<-chan int) <-chan int {
	out := make(chan int)
	var wg sync.WaitGroup
	for _, c := range chans {
		wg.Add(1)
		go func(c <-chan int) {
			defer wg.Done()
			for v := range c {
				out <- v
			}
		}(c)
	}
	go func() {
		wg.Wait()
		close(out)
	}()
	return out
}

// worker consumes jobs and emits squares until the jobs channel closes.
func worker(id int, jobs <-chan int, out chan<- int, wg *sync.WaitGroup) {
	defer wg.Done()
	for j := range jobs {
		time.Sleep(5 * time.Millisecond) // pretend to be busy
		out <- j * j
		_ = id
	}
}

func main() {
	fmt.Println("worker pool over 8 jobs")

	jobs := make(chan int, 8)
	results := make(chan int, 8)

	var wg sync.WaitGroup
	for w := 1; w <= 3; w++ {
		wg.Add(1)
		go worker(w, jobs, results, &wg)
	}
	for i := 1; i <= 8; i++ {
		jobs <- i
	}
	close(jobs)

	go func() {
		wg.Wait()
		close(results)
	}()

	sum := 0
	for r := range results {
		sum += r
		fmt.Printf("  got square %d\\n", r)
	}
	fmt.Printf("sum of squares = %d\\n", sum)

	// fan-in demo
	a := make(chan int, 3)
	b := make(chan int, 3)
	for i := 0; i < 3; i++ {
		a <- i
		b <- i * 10
	}
	close(a)
	close(b)
	for v := range fanIn(a, b) {
		fmt.Printf("  merged %d\\n", v)
	}
}
`;

const GO_STRUCTS = `// Structs, methods, interfaces and embedding.
package main

import (
	"fmt"
	"sort"
	"strings"
)

type Shape interface {
	Area() float64
	Name() string
}

type Rect struct {
	W, H float64
}

func (r Rect) Area() float64 { return r.W * r.H }
func (r Rect) Name() string  { return "rect" }

type Circle struct{ R float64 }

func (c Circle) Area() float64 { return 3.14159265 * c.R * c.R }
func (c Circle) Name() string  { return "circle" }

// String makes Rect printable with %v / %s.
func (r Rect) String() string {
	return fmt.Sprintf("Rect(%.0fx%.0f)", r.W, r.H)
}

// Labeled embeds Rect: it inherits Area/Name and adds a field.
type Labeled struct {
	Rect
	Label string
}

func main() {
	shapes := []Shape{
		Rect{W: 3, H: 4},
		Circle{R: 1},
		Labeled{Rect: Rect{W: 2, H: 2}, Label: "tile"},
	}

	// Interface dispatch — no type switch needed to call Area().
	for _, s := range shapes {
		fmt.Printf("%-10s area=%8.3f\\n", s.Name(), s.Area())
	}

	total := 0.0
	for _, s := range shapes {
		total += s.Area()
	}
	fmt.Printf("total area = %.3f\\n", total)

	// Embedded methods are promoted.
	l := Labeled{Rect: Rect{W: 5, H: 5}, Label: "board"}
	fmt.Printf("embedded: %s label=%s area=%.1f\\n", l.Rect, l.Label, l.Area())

	names := []string{"carol", "alice", "bob"}
	sort.Strings(names)
	fmt.Println("sorted:", strings.Join(names, ", "))
}
`;

const GO_ERROR = `// Error handling: wrapping, unwrapping, and a panic that is recovered.
package main

import (
	"errors"
	"fmt"
)

var ErrNotFound = errors.New("not found")

func lookup(id int) (string, error) {
	if id < 0 {
		return "", fmt.Errorf("lookup %d: %w", id, ErrNotFound)
	}
	return fmt.Sprintf("record-%d", id), nil
}

func safeDivide(a, b float64) (result float64, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("recovered: %v", r)
		}
	}()
	return a / b, nil
}

func main() {
	fmt.Println("about to look up a missing record...")

	_, err := lookup(-1)
	if err != nil {
		fmt.Println("error:", err)
		// errors.Is walks the %w chain.
		fmt.Println("is ErrNotFound:", errors.Is(err, ErrNotFound))
	}

	v, err := lookup(7)
	fmt.Printf("lookup(7) = %q err=%v\\n", v, err)

	// This one divides by zero and is caught by the deferred recover.
	r, err := safeDivide(1, 0)
	fmt.Printf("safeDivide(1, 0) = %v err=%v\\n", r, err)

	fmt.Println("reached the end — no crash")
}
`;


// ============================================================ Markdown
//
// Markdown samples render in the Preview pane (right tool window) instead of
// running. The tour sample is deliberately a *complete* exercise of the
// renderer: every block and inline feature it supports appears here, so the
// preview doubles as a visual regression fixture.

const MD_TOUR = `# Nolanguage Markdown Tour

Everything the built-in renderer supports, on one page.

## Text formatting

**bold**, *italic*, ***both***, ~~struck out~~, \*escaped\*, and \`inline code\`
with a backtick inside: \`\` \`x\` \`\`. A [link](https://example.com "Example"),
an <https://example.com/auto> autolink, and a [reference link][repo].

[repo]: https://github.com/ "GitHub"

## Lists

- unordered item
- another one
  - nested under it
  - back at two

1. ordered first
2. ordered second
   1. deeper
3. third

- [x] finished task
- [ ] pending task

## Quote

> Quoted text, with **bold** inside.
> > Nested quote, quoting a quote.

## Table

| Feature      | Status | Notes              |
| ------------ | :----: | ------------------ |
| Headings     |   yes  | ATX and setext     |
| Tables       |   yes  | GFM, aligned cells |
| Task lists   |   yes  | \`[x]\` and \`[ ]\`   |

## Code

\`\`\`python
def greet(name):
    return f"hello, {name}"
\`\`\`

    indented code block
    second line

## Rules and breaks

---

Text after a rule.

Hard break at the end of this line  
second line of the same paragraph.

---

Safety: raw HTML is escaped, and only safe URL schemes become links.
`;

const MD_FRONTMATTER = `---
title: Release notes
date: 2026-10-15
tags: [release, markdown, stage-8]
---

# Release notes

Stage 8 adds the Markdown workspace: a zero-dependency renderer, a live
preview pane, a heading outline, and optional marksman LSP integration.

## What works

- **Preview** — the right tool window renders the active document on a
  250 ms debounce, and reports render time in its header.
- **Outline** — the Structure tool window lists every heading with its line
  number; clicking one moves the caret there.
- **Breadcrumbs** — the nearest heading above the caret joins the path.

## What degrades

Without marksman installed, link completion and hover are unavailable, but
rendering, the outline and breadcrumbs keep working. The status bar says so
explicitly rather than failing silently.
`;

// ============================================================ JavaScript

// The JavaScript sandbox runs a snippet *synchronously* inside a shared node
// worker (see `src/js/JsRunner.ts`), so every sample here is timer- and
// promise-free by contract, and a failure is signalled by throwing.
const JS_DEMO_TEST = `// A tiny demo test — no dependencies, just assertions.
//
// Press Run (Ctrl+Enter). Each check prints PASS/FAIL, then a summary line.
// The failed check throws at the end, and an uncaught throw is what makes the
// run exit non-zero (there is no process.exit in the sandbox).
//
// Execution is synchronous per run, so this file deliberately uses no timers
// and no promises — see the header of src/js/JsRunner.ts for the contract.

function add(a, b) {
  return a + b;
}

function divide(a, b) {
  if (b === 0) throw new Error('division by zero');
  return a / b;
}

function isPalindrome(text) {
  const cleaned = Array.from(text.toLowerCase())
    .filter(function (ch) { return /[a-z0-9]/.test(ch); })
    .join('');
  return cleaned === Array.from(cleaned).reverse().join('');
}

// ---- a minimal test harness ----
const failures = [];

function check(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log('PASS  ' + name);
    return;
  }
  console.log('FAIL  ' + name + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
  failures.push(name);
}

function attempt(fn) {
  try { return fn(); } catch (err) { return err.message; }
}

console.log('running demo tests');
console.log('-'.repeat(40));

check('add two ints', add(2, 3), 5);
check('add negatives', add(-4, -6), -10);
check('divide exact', divide(10, 2), 5);
check('divide by zero throws', attempt(function () { return divide(1, 0); }), 'division by zero');
check('palindrome simple', isPalindrome('racecar'), true);
check('palindrome with punctuation', isPalindrome('A man, a plan, a canal: Panama'), true);
check('not a palindrome', isPalindrome('javascript'), false);

// Expected failure so you can see a FAIL line and a non-zero exit code.
check('intentional failing case', add(1, 1), 3);

console.log('-'.repeat(40));
if (failures.length) {
  throw new Error(failures.length + ' check(s) failed: ' + failures.join(', '));
}
console.log('all checks passed');
`;

const JS_HELLO = `// Hello world, plus a few language basics.
//
// The sandbox exposes a small read-only \`process\` stub (version / platform /
// env / argv). Each Run gets a fresh context inside the shared node process, so
// nothing carries over between runs — that is what lets a snippet with a
// top-level \`const\` be Run twice.

const who = 'JavaScript';

function greet(name) {
  return 'hello, ' + name + ' from ' + who;
}

console.log(greet('world'));
console.log('node ' + process.version + ' on ' + process.platform);

// arrow functions + array methods
const nums = [3, 1, 4, 1, 5, 9, 2, 6];
const evensDoubled = nums.filter((n) => n % 2 === 0).map((n) => n * 2);
console.log('evens x2:', evensDoubled.join(','));

// destructuring + spread
const { min, max } = { min: Math.min(...nums), max: Math.max(...nums) };
const total = nums.reduce((a, b) => a + b, 0);
console.log(\`min=\${min} max=\${max} total=\${total}\`);

// classes + getters
class Shape {
  constructor(name) { this.name = name; }
  get label() { return '<' + this.name + '>'; }
}

class Rect extends Shape {
  constructor(w, h) { super('rect'); this.w = w; this.h = h; }
  get area() { return this.w * this.h; }
}

const box = new Rect(4, 5);
console.log(box.label + ' area=' + box.area);

// runs are independent: this counter is always 1, because each Run starts from
// a fresh context (it is what makes re-Running a \`const\` snippet work at all)
globalThis.runs = (globalThis.runs || 0) + 1;
console.log('runs visible to this snippet: ' + globalThis.runs);
`;

// ============================================================ registry

export const SAMPLES: Sample[] = [
  // --- Python ---
  { id: 'py-demo-test', name: 'Demo test (assertions)', languageId: 'python', mode: 'run', code: PY_DEMO_TEST },
  { id: 'py-hello', name: 'Hello + session state', languageId: 'python', mode: 'run', code: PY_HELLO },
  { id: 'py-fib', name: 'Fibonacci + timing', languageId: 'python', mode: 'run', code: PY_FIBONACCI },
  { id: 'py-data', name: 'Data processing report', languageId: 'python', mode: 'run', code: PY_DATA },
  { id: 'py-session', name: 'Session persistence', languageId: 'python', mode: 'run', code: PY_SESSION },
  { id: 'py-error', name: 'Error handling (stderr)', languageId: 'python', mode: 'run', code: PY_ERROR },
  // --- Go ---
  { id: 'go-demo-test', name: 'Demo test (assertions)', languageId: 'go', mode: 'run', code: GO_DEMO_TEST },
  { id: 'go-test', name: 'Go test (testing pkg)', languageId: 'go', mode: 'test', code: GO_TEST },
  { id: 'go-hello', name: 'Hello + timing', languageId: 'go', mode: 'run', code: GO_HELLO },
  { id: 'go-concurrency', name: 'Goroutines + channels', languageId: 'go', mode: 'run', code: GO_CONCURRENCY },
  { id: 'go-structs', name: 'Structs + interfaces', languageId: 'go', mode: 'run', code: GO_STRUCTS },
  { id: 'go-error', name: 'Errors + recover', languageId: 'go', mode: 'run', code: GO_ERROR },
  // --- JavaScript (executed by the sandbox warm pool) ---
  { id: 'js-demo-test', name: 'Demo test (assertions)', languageId: 'javascript', mode: 'run', code: JS_DEMO_TEST },
  { id: 'js-hello', name: 'Hello + session state', languageId: 'javascript', mode: 'run', code: JS_HELLO },
  // --- Markdown (rendered, not run) ---
  { id: 'md-tour', name: 'Renderer feature tour', languageId: 'markdown', code: MD_TOUR },
  { id: 'md-frontmatter', name: 'Frontmatter + tags', languageId: 'markdown', code: MD_FRONTMATTER },
];

/** Samples for one language, in declaration order. */
export function samplesFor(languageId: LanguageId): Sample[] {
  return SAMPLES.filter((s) => s.languageId === languageId);
}

/** Look a sample up by id (throws on a typo, so tests fail loudly). */
export function sampleById(id: string): Sample {
  const s = SAMPLES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown sample id: ${id}`);
  return s;
}

/**
 * The sample a language starts with: its first declared sample, else a blank
 * starter named after the plugin.
 *
 * No language is special-cased — a plugin with no samples at all still gets a
 * valid (empty) buffer, which is what `starterFor` is for.
 */
export function defaultSample(languageId: LanguageId = 'python'): Sample {
  return samplesFor(languageId)[0] ?? starterFor(languageId);
}
