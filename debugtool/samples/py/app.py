"""Sample target for the debug observatory.

Deliberately contains the four things the tool has to survive:

  - nesting        main -> work -> step        (hot stacks)
  - a blocked stretch  time.sleep() inside work (stall detection)
  - a cycle        order.parent is order        (serializer must not hang)
  - a secret       api_token                    (redaction before it leaves the process)

Run it under the observatory, or plainly: `python -u app.py [rounds]`.
"""
import sys
import time


class Item:
    def __init__(self, name, price):
        self.name = name
        self.price = price

    @property
    def label(self):
        # An accessor: the serializer must report it as [getter], never call it.
        return f"{self.name} ({self.price})"


class Order:
    def __init__(self, oid):
        self.id = oid
        self.items = [Item(f"item{i}", i * 1.5) for i in range(3)]
        self.api_token = "sk-live-should-never-leave-the-process"
        self.parent = None  # becomes a cycle below


def step(n):
    total = 0
    for i in range(n):
        total += i * i
    return total


def work(rounds):
    acc = 0
    for _ in range(rounds):
        acc += step(2000)
        time.sleep(0.05)  # the "blocked" stretch a stall detector should see
    return acc


def main():
    # Rounds are an argument so the observatory can keep the program alive long
    # enough to poke at it: `python app.py 60` runs for ~3 s.
    rounds = 20
    if len(sys.argv) > 1:
        try:
            rounds = max(1, int(sys.argv[1]))
        except ValueError:
            pass
    order = Order(12)
    order.parent = order  # cycle
    total = work(rounds)
    print("total", total, "items", len(order.items), "token-prefix", order.api_token[:3])


if __name__ == "__main__":
    main()
