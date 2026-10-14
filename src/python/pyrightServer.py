#!/usr/bin/env python3
"""
Bundled Python language server for the Nolanguage Stage-3 closed loop.

This is a *real* LSP server speaking JSON-RPC over stdio with Content-Length
framing (stdlib only, no dependencies). It exists so the closed loop
(编辑器 -> LSP -> 诊断/补全 -> 日志/性能) runs end-to-end even on a machine
without pyright or network access.

If `pyright-langserver` is present, `LspClient.discoverPythonServer()` prefers
it; this server is the fallback. Both are driven by exactly the same client, so
the instrumentation and log collection are identical.

Implements: initialize, initialized, shutdown, exit,
            textDocument/didOpen, textDocument/didChange,
            textDocument/completion, textDocument/hover,
            textDocument/diagnostic (pull), and push publishDiagnostics.

It also emits deliberately varied stderr output (plain levels, a JSON line, a
multi-line stack trace) so the LSP log collector has realistic material.
"""
from __future__ import annotations

import ast
import builtins
import json
import sys
import time
import traceback
from typing import Any

SERVER_NAME = "nolanguage-py"
SERVER_VERSION = "0.3.0"

BUILTIN_NAMES = set(dir(builtins))

# Common names people expect to autocomplete.
COMMON_ITEMS = [
    "print", "len", "range", "enumerate", "zip", "sorted", "sum", "min", "max",
    "dict", "list", "set", "tuple", "str", "int", "float", "bool", "open",
    "isinstance", "getattr", "setattr", "hasattr", "super", "self", "None",
    "True", "False", "Exception", "ValueError", "TypeError",
]

COMPLETION_KIND_FUNCTION = 3
COMPLETION_KIND_VARIABLE = 6


def log(level: str, message: str, **fields: Any) -> None:
    """Write a structured log line to stderr (consumed by LspLogCollector)."""
    ts = time.strftime("%H:%M:%S")
    extra = (" " + json.dumps(fields)) if fields else ""
    sys.stderr.write(f"[{level} - {ts}] {message}{extra}\n")
    sys.stderr.flush()


class Doc:
    def __init__(self, uri: str, text: str, version: int = 1) -> None:
        self.uri = uri
        self.text = text
        self.version = version


class Server:
    def __init__(self) -> None:
        self.docs: dict[str, Doc] = {}
        self.shutdown_requested = False

    # ---------------- transport ----------------

    def read_message(self) -> dict[str, Any] | None:
        stdin = sys.stdin.buffer
        headers: dict[str, str] = {}
        while True:
            line = stdin.readline()
            if not line:
                return None
            line = line.decode("ascii", errors="replace").strip()
            if line == "":
                break
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        length = int(headers.get("content-length", "0"))
        if length <= 0:
            return None
        body = stdin.read(length)
        if not body:
            return None
        try:
            return json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            log("Error", "Failed to parse JSON-RPC body", bytes=length)
            return None

    def write_message(self, msg: dict[str, Any]) -> None:
        body = json.dumps(msg).encode("utf-8")
        out = sys.stdout.buffer
        out.write(f"Content-Length: {len(body)}\r\n\r\n".encode("ascii"))
        out.write(body)
        out.flush()

    def respond(self, msg_id: Any, result: Any) -> None:
        self.write_message({"jsonrpc": "2.0", "id": msg_id, "result": result})

    def respond_error(self, msg_id: Any, code: int, message: str) -> None:
        self.write_message(
            {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}
        )

    def notify(self, method: str, params: Any) -> None:
        self.write_message({"jsonrpc": "2.0", "method": method, "params": params})

    # ---------------- lifecycle ----------------

    def handle(self, msg: dict[str, Any]) -> bool:
        """Return False to stop the loop."""
        method = msg.get("method")
        msg_id = msg.get("id")
        params = msg.get("params") or {}

        if method == "initialize":
            self.respond(
                msg_id,
                {
                    "capabilities": {
                        "textDocumentSync": {"openClose": True, "change": 1},
                        "completionProvider": {"triggerCharacters": [".", "("]},
                        "hoverProvider": True,
                        "diagnosticProvider": {"interFileDependencies": False, "workspaceDiagnostics": False},
                    },
                    "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                },
            )
            return True

        if method == "initialized":
            log("Info", "Server initialized", server=SERVER_NAME, version=SERVER_VERSION)
            return True

        if method == "shutdown":
            self.shutdown_requested = True
            log("Info", "Shutdown requested")
            self.respond(msg_id, None)
            return True

        if method == "exit":
            log("Info", "Exit notification received", code=0 if self.shutdown_requested else 1)
            return False

        if method == "textDocument/didOpen":
            td = params.get("textDocument", {})
            doc = Doc(td.get("uri", ""), td.get("text", ""), td.get("version", 1))
            self.docs[doc.uri] = doc
            log("Debug", "Document opened", uri=doc.uri, version=doc.version,
                lines=doc.text.count("\n") + 1)
            self.publish_diagnostics(doc)
            return True

        if method == "textDocument/didChange":
            td = params.get("textDocument", {})
            uri = td.get("uri", "")
            changes = params.get("contentChanges", [])
            if uri in self.docs and changes:
                self.docs[uri].text = changes[-1].get("text", self.docs[uri].text)
                self.docs[uri].version = td.get("version", self.docs[uri].version)
                self.publish_diagnostics(self.docs[uri])
            return True

        if method == "textDocument/didClose":
            td = params.get("textDocument", {})
            self.docs.pop(td.get("uri", ""), None)
            return True

        if method == "textDocument/completion":
            self.respond(msg_id, {"items": self.completion(params)})
            return True

        if method == "textDocument/hover":
            self.respond(msg_id, self.hover(params))
            return True

        if method == "textDocument/diagnostic":
            td = params.get("textDocument", {})
            uri = td.get("uri", "")
            doc = self.docs.get(uri)
            items = self.analyze(doc.text) if doc else []
            self.respond(msg_id, {"items": items, "kind": "full"})
            return True

        if msg_id is not None:
            # Unknown request: respond so the client doesn't time out.
            self.respond_error(msg_id, -32601, f"Method not implemented: {method}")
        return True

    # ---------------- features ----------------

    def completion(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        uri = params.get("textDocument", {}).get("uri", "")
        doc = self.docs.get(uri)
        names = set(COMMON_ITEMS)
        if doc:
            try:
                tree = ast.parse(doc.text)
                for node in ast.walk(tree):
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                        names.add(node.name)
                    elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
                        names.add(node.id)
                    elif isinstance(node, ast.Import):
                        for a in node.names:
                            names.add(a.asname or a.name.split(".")[0])
                    elif isinstance(node, ast.ImportFrom):
                        for a in node.names:
                            names.add(a.asname or a.name)
            except SyntaxError:
                pass
        items = [
            {"label": n, "kind": COMPLETION_KIND_FUNCTION if n in COMMON_ITEMS else COMPLETION_KIND_VARIABLE}
            for n in sorted(names)
        ]
        log("Trace", "Completion computed", uri=uri, count=len(items))
        return items

    def hover(self, params: dict[str, Any]) -> dict[str, Any] | None:
        uri = params.get("textDocument", {}).get("uri", "")
        pos = params.get("position", {})
        doc = self.docs.get(uri)
        if not doc:
            return None
        line = doc.text.split("\n")[pos.get("line", 0)] if doc.text else ""
        word = _word_at(line, pos.get("character", 0))
        if not word:
            return None
        if word in BUILTIN_NAMES:
            doc_text = (getattr(builtins, word).__doc__ or "builtin").strip().split("\n")[0]
            return {"contents": {"kind": "markdown", "value": f"**builtin** `{word}`\n\n{doc_text}"}}
        return {"contents": {"kind": "markdown", "value": f"`{word}` (defined in this module)"}}

    def publish_diagnostics(self, doc: Doc) -> None:
        diags = self.analyze(doc.text)
        self.notify(
            "textDocument/publishDiagnostics",
            {"uri": doc.uri, "version": doc.version, "diagnostics": diags},
        )
        errors = sum(1 for d in diags if d["severity"] == 1)
        warns = sum(1 for d in diags if d["severity"] == 2)
        log("Info", "Diagnostics published", uri=doc.uri, total=len(diags),
            errors=errors, warnings=warns)

    def analyze(self, text: str) -> list[dict[str, Any]]:
        """Syntax errors + undefined names + unused imports."""
        diags: list[dict[str, Any]] = []
        try:
            tree = ast.parse(text)
        except SyntaxError as e:
            diags.append({
                "range": _range(max((e.lineno or 1) - 1, 0), max((e.offset or 1) - 1, 0)),
                "severity": 1,
                "code": "syntax-error",
                "source": SERVER_NAME,
                "message": f"SyntaxError: {e.msg}",
            })
            return diags

        defined: set[str] = set()
        imported: dict[str, tuple[int, int]] = {}
        used: set[str] = set()

        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                defined.add(node.name)
            elif isinstance(node, ast.arg):
                defined.add(node.arg)
            elif isinstance(node, ast.Name):
                if isinstance(node.ctx, ast.Store):
                    defined.add(node.id)
                else:
                    used.add(node.id)
            elif isinstance(node, ast.Import):
                for a in node.names:
                    name = a.asname or a.name.split(".")[0]
                    defined.add(name)
                    imported[name] = (node.lineno - 1, node.col_offset)
            elif isinstance(node, ast.ImportFrom):
                for a in node.names:
                    name = a.asname or a.name
                    defined.add(name)
                    imported[name] = (node.lineno - 1, node.col_offset)

        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                if node.id not in defined and node.id not in BUILTIN_NAMES:
                    diags.append({
                        "range": _range(node.lineno - 1, node.col_offset, len(node.id)),
                        "severity": 2,
                        "code": "undefined-name",
                        "source": SERVER_NAME,
                        "message": f"'{node.id}' is not defined",
                    })

        for name, (line, col) in imported.items():
            if name not in used:
                diags.append({
                    "range": _range(line, col, len(name)),
                    "severity": 3,
                    "code": "unused-import",
                    "source": SERVER_NAME,
                    "message": f"'{name}' imported but unused",
                })

        return diags


def _range(line: int, char: int, length: int = 1) -> dict[str, Any]:
    return {
        "start": {"line": line, "character": char},
        "end": {"line": line, "character": char + max(length, 1)},
    }


def _word_at(line: str, char: int) -> str:
    if not line:
        return ""
    start = min(char, len(line))
    while start > 0 and (line[start - 1].isalnum() or line[start - 1] == "_"):
        start -= 1
    end = min(char, len(line))
    while end < len(line) and (line[end].isalnum() or line[end] == "_"):
        end += 1
    return line[start:end]


def main() -> int:
    log("Info", "Starting language server", server=SERVER_NAME, version=SERVER_VERSION,
        python=sys.version.split()[0])
    server = Server()
    try:
        while True:
            msg = server.read_message()
            if msg is None:
                log("Info", "stdin closed, shutting down")
                break
            if not server.handle(msg):
                break
    except Exception:  # noqa: BLE001 - top-level guard for a long-running server
        # Deliberately emit a multi-line traceback to exercise the collector's
        # continuation-line folding.
        sys.stderr.write("Error: unhandled exception in language server\n")
        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
