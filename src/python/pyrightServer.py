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
import keyword
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
                        "completionProvider": {"triggerCharacters": [".", "("], "resolveProvider": True},
                        "hoverProvider": True,
                        "definitionProvider": True,
                        "referencesProvider": True,
                        "renameProvider": True,
                        "codeActionProvider": True,
                        "workspaceSymbolProvider": True,
                        "signatureHelpProvider": {"triggerCharacters": ["(", ","]},
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

        if method == "textDocument/definition":
            self.respond(msg_id, self.definition(params))
            return True

        if method == "textDocument/references":
            self.respond(msg_id, self.references(params))
            return True

        if method == "textDocument/rename":
            self.respond(msg_id, self.rename(params))
            return True

        if method == "textDocument/codeAction":
            self.respond(msg_id, self.code_actions(params))
            return True

        if method == "completionItem/resolve":
            self.respond(msg_id, self.resolve_completion(params))
            return True

        if method == "textDocument/signatureHelp":
            self.respond(msg_id, self.signature_help(params))
            return True

        if method == "workspace/symbol":
            self.respond(msg_id, self.workspace_symbols(params))
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


    # ---------------- navigation ----------------
    #
    # Same-file only: this server has no index, so `workspace/symbol` answers for
    # the open document. That is a limit of the fallback, not of the protocol —
    # pyright answers across the project.
    #
    # Positions are 0-based line/character, as LSP counts them. This stub counts
    # code points, which matches UTF-16 for ASCII; an emoji on the same line as an
    # identifier can shift a column.

    def _doc(self, params: dict[str, Any]) -> tuple[str, "Doc | None"]:
        uri = params.get("textDocument", {}).get("uri", "")
        return uri, self.docs.get(uri)

    def _ident_at(self, text: str, line: int, character: int) -> tuple[str, int, int] | None:
        """Identifier under the cursor, with its start/end column on that line."""
        rows = text.splitlines()
        if line < 0 or line >= len(rows):
            return None
        row = rows[line]
        character = self._u16_to_cp(row, max(0, character))
        start = character
        while start > 0 and (row[start - 1].isalnum() or row[start - 1] == "_"):
            start -= 1
        end = character
        while end < len(row) and (row[end].isalnum() or row[end] == "_"):
            end += 1
        if start == end:
            return None
        return row[start:end], start, end

    def _name_span(self, text: str, node: ast.AST, name: str) -> tuple[int, int, int]:
        """(line, start, end) of `name` on the node's first line."""
        rows = text.splitlines()
        line = getattr(node, "lineno", 1) - 1
        row = rows[line] if 0 <= line < len(rows) else ""
        start = row.find(name, self._u8_to_cp(row, getattr(node, "col_offset", 0)))
        if start < 0:
            start = self._u8_to_cp(row, getattr(node, "col_offset", 0))
        return line, start, start + len(name)

    @staticmethod
    def _u16_to_cp(row: str, col: int) -> int:
        """LSP counts UTF-16 code units; Python counts code points.

        An astral character (an emoji) is one code point but two units, so every
        column after it drifts by one per character. Positions from the client
        are converted in, positions to the client are converted out.
        """
        if col <= 0:
            return 0
        units = 0
        for i, ch in enumerate(row):
            w = 2 if ord(ch) > 0xFFFF else 1
            if units + w > col:
                return i
            units += w
        return len(row)

    @staticmethod
    def _u8_to_cp(row: str, byte_col: int) -> int:
        """`ast` reports UTF-8 byte offsets; every other layer here counts code points."""
        if byte_col <= 0:
            return 0
        return len(row.encode("utf-8")[:byte_col].decode("utf-8", "ignore"))

    @staticmethod
    def _cp_to_u16(row: str, col: int) -> int:
        if col <= 0:
            return 0
        return len(row[:col].encode("utf-16-le")) // 2

    def _loc(self, uri: str, row: str, line: int, start: int, end: int) -> dict[str, Any]:
        """Build a Location from code-point columns, emitting UTF-16 units."""
        return {
            "uri": uri,
            "range": {
                "start": {"line": line, "character": self._cp_to_u16(row, start)},
                "end": {"line": line, "character": self._cp_to_u16(row, end)},
            },
        }

    def _parse(self, text: str) -> ast.AST | None:
        try:
            return ast.parse(text)
        except SyntaxError:
            return None

    def _occurrences(self, text: str, tree: ast.AST, name: str) -> list[tuple[int, int, int]]:
        rows = text.splitlines()
        spans = []
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == name:
                spans.append(self._name_span(text, node, name))
            elif isinstance(node, ast.Name) and node.id == name:
                line = node.lineno - 1
                row = rows[line] if 0 <= line < len(rows) else ""
                # `ast` col_offset is a UTF-8 byte offset; convert before it meets
                # anything that counts code points.
                start = self._u8_to_cp(row, node.col_offset)
                spans.append((line, start, start + len(name)))
        return sorted(set(spans))

    def definition(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        uri, doc = self._doc(params)
        if doc is None:
            return []
        pos = params.get("position", {})
        hit = self._ident_at(doc.text, pos.get("line", 0), pos.get("character", 0))
        tree = self._parse(doc.text)
        if hit is None or tree is None:
            return []
        name = hit[0]
        rows = doc.text.splitlines()
        out = []
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == name:
                line, start, end = self._name_span(doc.text, node, name)
                out.append(self._loc(uri, rows[line], line, start, end))
            elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store) and node.id == name:
                line = node.lineno - 1
                row = rows[line]
                start = self._u8_to_cp(row, node.col_offset)
                out.append(self._loc(uri, row, line, start, start + len(name)))
        return out

    def resolve_completion(self, params: dict[str, Any]) -> dict[str, Any]:
        """Fill in the documentation for one completion item.

        The list frame carries labels only; this is what the client asks for when
        the user pauses on a row. Builtins get their docstring, everything else
        says where it comes from.
        """
        label = params.get("label", "")
        out = dict(params)
        obj = getattr(builtins, label, None)
        if obj is not None and getattr(obj, "__doc__", None):
            first = (obj.__doc__ or "").strip().split("\n")[0]
            out["documentation"] = {"kind": "markdown", "value": f"**builtin** `{label}`\n\n{first}"}
            out["detail"] = "builtin"
            return out
        doc = self.docs.get(params.get("uri", "")) if params.get("uri") else None
        if doc:
            tree = self._parse(doc.text)
            if tree is not None:
                for node in ast.walk(tree):
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == label:
                        first = (ast.get_docstring(node) or "").strip().split("\n")[0]
                        kind = "class" if isinstance(node, ast.ClassDef) else "function"
                        out["documentation"] = {"kind": "markdown", "value": f"**{kind}** `{label}`\n\n{first}" if first else f"**{kind}** `{label}`"}
                        out["detail"] = f"{kind} in this module"
                        return out
        out["detail"] = "name in this module"
        return out

    def signature_help(self, params: dict[str, Any]) -> dict[str, Any] | None:
        """Parameter hints for the call under the caret.

        Same-file and call-site only: the signature comes from a `def` in this
        module, or from the builtin table. No library introspection - that is what
        a real server is for.
        """
        uri, doc = self._doc(params)
        if doc is None:
            return None
        pos = params.get("position", {})
        line = pos.get("line", 0)
        character = self._u16_to_cp(doc.text.splitlines()[line] if line < len(doc.text.splitlines()) else "", pos.get("character", 0))
        tree = self._parse(doc.text)
        if tree is None:
            return None

        # Innermost Call whose span contains the caret.
        best = None
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            start = (node.lineno - 1, node.col_offset)
            end = (getattr(node, "end_lineno", node.lineno) - 1, getattr(node, "end_col_offset", 0))
            if start <= (line, character) <= end:
                if best is None or start >= (best.lineno - 1, best.col_offset):
                    best = node
        if best is None:
            return None

        func = best.func
        name = func.id if isinstance(func, ast.Name) else (func.attr if isinstance(func, ast.Attribute) else None)
        if not name:
            return None

        args: list[str] = []
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
                args = [a.arg for a in node.args.args]
                break
        else:
            obj = getattr(builtins, name, None)
            if obj is None or not callable(obj):
                return None
            try:
                import inspect

                args = [p for p in inspect.signature(obj).parameters]
            except (TypeError, ValueError):
                args = []

        # Active parameter: count top-level commas between the opening paren and
        # the caret, ignoring anything inside nested brackets or strings.
        rows = doc.text.splitlines()
        start_line = best.lineno - 1
        open_col = rows[start_line].find("(", max(0, best.col_offset)) if start_line < len(rows) else -1
        if open_col < 0:
            open_col = best.col_offset
        active = 0
        depth = 0
        quote = ""
        for ln in range(start_line, line + 1):
            row = rows[ln] if ln < len(rows) else ""
            lo = open_col + 1 if ln == start_line else 0
            hi = character if ln == line else len(row)
            for ch in row[lo:hi]:
                if quote:
                    if ch == quote:
                        quote = ""
                    continue
                if ch in "\"'":
                    quote = ch
                elif ch in "([{":
                    depth += 1
                elif ch in ")]}":
                    depth -= 1
                elif ch == "," and depth == 0:
                    active += 1

        label = f"{name}({', '.join(args)})"
        return {
            "signatures": [{"label": label, "documentation": f"defined in this module: {name}" if args else name}],
            "activeSignature": 0,
            "activeParameter": min(active, max(0, len(args) - 1)),
        }

    def references(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        uri, doc = self._doc(params)
        if doc is None:
            return []
        pos = params.get("position", {})
        hit = self._ident_at(doc.text, pos.get("line", 0), pos.get("character", 0))
        tree = self._parse(doc.text)
        if hit is None or tree is None:
            return []
        include_decl = (params.get("context") or {}).get("includeDeclaration", True)
        spans = self._occurrences(doc.text, tree, hit[0])
        if not include_decl:
            here = (pos.get("line", 0), hit[1])
            spans = [sp for sp in spans if (sp[0], sp[1]) != here]
        rows = doc.text.splitlines()
        return [self._loc(uri, rows[line], line, start, end) for line, start, end in spans]

    def rename(self, params: dict[str, Any]) -> dict[str, Any] | None:
        uri, doc = self._doc(params)
        new_name = params.get("newName", "")
        # An invalid identifier would leave a file that no longer parses; refusing
        # here is the difference between a warning and a broken edit.
        # str.isidentifier() is True for keywords ("class", "def", "None"), and
        # renaming to one produces a file that no longer parses.
        if doc is None or not new_name.isidentifier() or keyword.iskeyword(new_name):
            return None
        pos = params.get("position", {})
        hit = self._ident_at(doc.text, pos.get("line", 0), pos.get("character", 0))
        tree = self._parse(doc.text)
        if hit is None or tree is None:
            return None
        rows = doc.text.splitlines()
        edits = []
        for line, start, end in self._occurrences(doc.text, tree, hit[0]):
            edits.append({"range": self._loc(uri, rows[line], line, start, end)["range"], "newText": new_name})
        if not edits:
            return None
        return {"changes": {uri: edits}}

    def code_actions(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        uri, doc = self._doc(params)
        if doc is None:
            return []
        tree = self._parse(doc.text)
        if tree is None:
            return []
        rows = doc.text.splitlines()
        used = {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)}
        used |= {node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)}
        actions: list[dict[str, Any]] = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Import):
                continue
            for alias in node.names:
                bound = alias.asname or alias.name.split(".")[0]
                if bound in used:
                    continue
                line = node.lineno - 1
                # A line with a trailing newline is removed as (line,0)-(line+1,0).
                # The last line has no such newline, so the range would end past the
                # document; consume the *preceding* newline instead.
                if line + 1 < len(rows):
                    start = {"line": line, "character": 0}
                    end = {"line": line + 1, "character": 0}
                elif line > 0:
                    start = {"line": line - 1, "character": len(rows[line - 1])}
                    end = {"line": line, "character": len(rows[line])}
                else:
                    start = {"line": 0, "character": 0}
                    end = {"line": 0, "character": len(rows[0])}
                actions.append(
                    {
                        "title": f"Remove unused import '{alias.name}'",
                        "kind": "quickfix",
                        "edit": {"changes": {uri: [{"range": {"start": start, "end": end}, "newText": ""}]}},
                    }
                )
        return actions

    def workspace_symbols(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        query = (params.get("query") or "").lower()
        out = []
        for uri, doc in self.docs.items():
            tree = self._parse(doc.text)
            if tree is None:
                continue
            for node in tree.body:
                name = None
                kind = 13
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    name, kind = node.name, 12
                elif isinstance(node, ast.ClassDef):
                    name, kind = node.name, 5
                elif isinstance(node, ast.Assign):
                    targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
                    name = targets[0] if targets else None
                if not name or (query and query not in name.lower()):
                    continue
                line, start, end = self._name_span(doc.text, node, name)
                rows = doc.text.splitlines()
                out.append({"name": name, "kind": kind, "location": self._loc(uri, rows[line], line, start, end)})
        return out

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
