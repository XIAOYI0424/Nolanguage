// Sample target for the debug observatory (Go).
//
// Deliberately contains what the pprof path has to survive:
//
//   - nesting              main -> work -> step      (hot stacks)
//   - a blocking stretch    time.Sleep inside work    (stall detection)
//   - a background goroutine that just waits          (a second goroutine, always blocked)
//   - the pprof handler     the dump's own request     (must not become the hottest stack)
//
// It listens on a port the OS picks and prints it, so two runs never collide:
//
//	ndebug --attach http://127.0.0.1:<printed port>
package main

import (
	"fmt"
	"net"
	"net/http"
	_ "net/http/pprof"
	"os"
	"strconv"
	"time"
)

func step(n int) int {
	total := 0
	for i := 0; i < n; i++ {
		total += i * i
	}
	return total
}

func work(rounds int) int {
	acc := 0
	for i := 0; i < rounds; i++ {
		acc += step(2_000_000)
		time.Sleep(20 * time.Millisecond) // the "blocked" stretch a stall detector should see
	}
	return acc
}

func background() {
	for {
		time.Sleep(2 * time.Second)
	}
}

func main() {
	rounds := 400
	if len(os.Args) > 1 {
		if n, err := strconv.Atoi(os.Args[1]); err == nil && n > 0 {
			rounds = n
		}
	}

	// Port 0 lets the OS pick, and printing the real address is the only way to
	// know it without racing another process for a fixed port.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintln(os.Stderr, "listen:", err)
		os.Exit(1)
	}
	go http.Serve(ln, nil)
	go background()

	fmt.Printf("ready http://%s\n", ln.Addr().String())
	fmt.Println("total", work(rounds), "rounds", rounds)
}
