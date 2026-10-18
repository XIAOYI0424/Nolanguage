"""High-load CPU benchmark for the Nolanguage Python runner.

Manual test asset — not part of the automated suite, and it is not run by any
build step. Standard library only.

    python tests/bench_cpu.py                # ~3-4 s on a current desktop CPU
    python tests/bench_cpu.py --scale 2      # ~2x the work
    python tests/bench_cpu.py --scale 0.5    # quick smoke run

Sizing note: `builtin/python@1.0.0` declares `run.timeoutMs: 15000` for its
persistent interpreter session, so the workload is scaled to stay well under
that ceiling and `--scale` is capped at 3 (the estimator below refuses to go
past it, instead of silently timing the run out).

Every stage is pure Python on purpose: it measures the interpreter, not the
overhead of a library, which is what the panel's timing display is compared
against.
"""

from __future__ import annotations

import argparse
import platform
import sys
import time

# Base sizes for `--scale 1`. Tuned so the whole run lands around 3-4 seconds.
BASE_INTEGERS = 20_000_000
BASE_SIEVE = 5_000_000
BASE_MATRIX = 120
BASE_FIB_REPEATS = 2
BASE_STRINGS = 2_000_000

FIB_N = 30


def integer_accumulation(n: int) -> int:
    """Tight integer loop: multiply, mask, add. One add per iteration."""
    total = 0
    for i in range(n):
        total += (i * 2654435761) & 0xFFFFFFFF
    return total & 0xFFFFFFFF


def prime_sieve(limit: int) -> int:
    """Count primes below `limit` with a bytearray sieve (slice assignment)."""
    if limit < 2:
        return 0
    flags = bytearray(b"\x01") * (limit + 1)
    flags[0:2] = b"\x00\x00"
    for i in range(2, int(limit**0.5) + 1):
        if flags[i]:
            start = i * i
            flags[start::i] = b"\x00" * (((limit - start) // i) + 1)
    return sum(flags)


def matrix_multiply(size: int) -> int:
    """Dense integer matrix multiply, loop order chosen for cache behaviour."""
    a = [[(i * 7 + j * 3) % 97 for j in range(size)] for i in range(size)]
    b = [[(i * 5 - j * 11) % 89 for j in range(size)] for i in range(size)]
    c = [[0] * size for _ in range(size)]
    for i in range(size):
        row_a = a[i]
        row_c = c[i]
        for k in range(size):
            factor = row_a[k]
            if factor:
                row_b = b[k]
                for j in range(size):
                    row_c[j] += factor * row_b[j]
    return c[size - 1][size - 1]


def fib(n: int) -> int:
    """Naive recursion: ~2.7M calls for n=30, no memoisation by design."""
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)


def string_churn(n: int) -> int:
    """Dict + f-string + string repetition: allocation-heavy, not numeric."""
    buckets: dict[str, int] = {}
    for i in range(n):
        key = str(i % 1000)
        buckets[key] = buckets.get(key, 0) + len("%d-%s" % (i, "x" * (i % 7)))
    return sum(buckets.values())


def run_stage(index: int, total: int, name: str, detail: str, func, arg) -> tuple[float, float]:
    """Time one stage on both clocks and print a single aligned line."""
    wall_start = time.perf_counter()
    cpu_start = time.process_time()
    result = func(arg)
    wall = time.perf_counter() - wall_start
    cpu = time.process_time() - cpu_start
    print(
        "[%d/%d] %-22s %-18s wall=%7.3fs cpu=%7.3fs -> %s"
        % (index, total, name, detail, wall, cpu, result)
    )
    return wall, cpu


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Nolanguage Python CPU benchmark")
    parser.add_argument(
        "--scale",
        type=float,
        default=1.0,
        help="workload multiplier (default 1.0, capped at 3.0 to stay under the 15 s runner timeout)",
    )
    args = parser.parse_args(argv)

    scale = max(0.05, min(3.0, args.scale))
    if scale != args.scale:
        print("note: --scale clamped to %.2f (runner timeout is 15 s)" % scale)

    print("Nolanguage CPU benchmark")
    print("python %s | %s | %s" % (platform.python_version(), platform.platform(), sys.executable))
    print("scale %.2f" % scale)
    print("-" * 96)

    integers = int(BASE_INTEGERS * scale)
    limit = int(BASE_SIEVE * scale)
    matrix = max(8, int(BASE_MATRIX * (scale**0.5)))
    fib_repeats = max(1, round(BASE_FIB_REPEATS * scale))
    strings = int(BASE_STRINGS * scale)

    stages: list[tuple] = [
        ("integer accumulation", "%d" % integers, integer_accumulation, integers),
        ("prime sieve", "%d" % limit, prime_sieve, limit),
        ("matrix multiply", "%dx%d" % (matrix, matrix), matrix_multiply, matrix),
        ("recursive fib", "fib(%d) x%d" % (FIB_N, fib_repeats), lambda r: [fib(FIB_N) for _ in range(r)][-1], fib_repeats),
        ("string churn", "%d" % strings, string_churn, strings),
    ]

    total = len(stages)
    wall_total = 0.0
    cpu_total = 0.0
    started = time.perf_counter()

    for index, (name, detail, func, arg) in enumerate(stages, start=1):
        wall, cpu = run_stage(index, total, name, detail, func, arg)
        wall_total += wall
        cpu_total += cpu

    elapsed = time.perf_counter() - started
    print("-" * 96)
    print("stages wall %.3fs | cpu %.3fs" % (wall_total, cpu_total))
    print("total  wall %.3fs | cpu %.3fs | overhead %.3fs" % (elapsed, time.process_time(), elapsed - wall_total))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
