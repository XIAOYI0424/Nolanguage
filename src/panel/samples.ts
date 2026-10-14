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
 */
export type LanguageId = 'python' | 'go';
export type RunMode = 'run' | 'test';

export interface Sample {
  id: string;
  name: string;
  languageId: LanguageId;
  /** Go only; Python always runs. */
  mode: RunMode;
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
}

export const LANGUAGES: LanguageDescriptor[] = [
  { id: 'python', displayName: 'Python', extension: '.py', fileName: 'main.py', supportsTest: false },
  { id: 'go', displayName: 'Go', extension: '.go', fileName: 'main.go', supportsTest: true },
];

export function language(id: LanguageId): LanguageDescriptor {
  return LANGUAGES.find((l) => l.id === id) ?? LANGUAGES[0];
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

/** The sample a language starts with — always its demo test. */
export function defaultSample(languageId: LanguageId = 'python'): Sample {
  const own = samplesFor(languageId);
  return own[0] ?? SAMPLES[0];
}
