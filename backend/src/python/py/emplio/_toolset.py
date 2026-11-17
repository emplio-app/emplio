"""Tools: functions an agent keeps so the next job of the same kind is one call.

They live one file per area (gmail.py, billing.py) in a toolset/ folder of a bucket: me/ (one person's own),
restricted/ (admins only) or company/ (everyone). A labelled function in one (`# risk: reads|changes|spends` on
the line above it) is a tool; anything else in the file is a helper, and a name starting with _ is private.
Code imports them like any module, `from tools.gmail import send`, own bucket first.

emplio.tools.save(fn, area=...) keeps a function the agent wrote in its Python session: the session remembers the
exact text of every top-level def, class, import and assignment it runs, so the save follows everything fn needs
(helpers at any depth, base classes, decorators, defaults, CAPS constants), links what is already a function in
another area instead of copying it, and refuses a value left over from the session (an email, a scraped list)
that should have been an input. The area's file is then loaded in a fresh Python before it's replaced, so a
broken save never lands.
"""
import ast, builtins, dis, importlib.abc, importlib.util, json, keyword, os, re, subprocess, sys, threading, types

W = os.environ.get("EMPLIO_WORK") or "/work"
BUCKETS = ("me", "restricted", "company")  # own first, like skills
RISKS = {"reads": "only reads", "changes": "changes things", "spends": "spends money"}
# a tool may call tools from its own bucket or a more open one
OPEN = {"company": ("company",), "restricted": ("restricted", "company"), "me": ("me", "restricted", "company")}
# names the Python session already has (kernel.fresh_namespace): a tool that uses one gets this line
GIVEN = {"emplio": "import emplio", "sh": "from emplio import sh", "json": "import json", "os": "import os", "re": "import re",
         "sys": "import sys", "Path": "from pathlib import Path"}
LOADS = {"LOAD_GLOBAL", "LOAD_NAME", "LOAD_FROM_DICT_OR_GLOBALS", "STORE_GLOBAL", "DELETE_GLOBAL"}
RISK_LINE = re.compile(r"^#\s*risk:\s*(\w+)", re.I)
AREA = re.compile(r"^[a-z][a-z0-9_]{0,40}$")


from . import EmplioError  # emplio imports this module once EmplioError exists


class ToolError(EmplioError):
    """A tool couldn't be saved or found; the message says what to do instead."""


# ---- what the session wrote ----

_src = {}  # name -> [kind, exact text]; kind: def | class | import | value | star | global (text: the function that sets it)
_drafts = None  # where this session's definitions are kept, so a new session (after a restart) can still save them


def start(session):
    """Keep this session's definitions in a drafts file, and pick up what an earlier session of it wrote."""
    global _drafts
    _drafts = os.path.join(W, "tmp", ".emplio", "sessions", f"{session}.drafts.json")
    try:
        with open(_drafts, encoding="utf-8") as f:
            _src.update(json.load(f))
    except (OSError, ValueError):
        pass


def blocks(code):
    """Top-level statements of some code: (kind, [names], exact text), the text from any comments just above it
    (and its decorators) to the end of its last line."""
    lines = code.splitlines()
    out = []
    for node in ast.parse(code).body:
        start = min([node.lineno] + [d.lineno for d in getattr(node, "decorator_list", [])])
        while start > 1 and lines[start - 2].lstrip().startswith("#") and not (out and out[-1][3] >= start - 1):
            start -= 1
        text = "\n".join(lines[start - 1 : node.end_lineno])
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out.append(("def", [node.name], text, node.end_lineno))
        elif isinstance(node, ast.ClassDef):
            out.append(("class", [node.name], text, node.end_lineno))
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            star = any(a.name == "*" for a in node.names)
            out.append(("star" if star else "import", [f"*{node.module}"] if star else [(a.asname or a.name).split(".")[0] for a in node.names], text, node.end_lineno))
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            names = [n.id for t in targets for n in ast.walk(t) if isinstance(n, ast.Name)]
            out.append(("value", names, text, node.end_lineno))
        elif isinstance(node, ast.Expr) and isinstance(getattr(node, "value", None), ast.Constant) and isinstance(node.value.value, str) and not out:
            out.append(("doc", [], text, node.end_lineno))
        else:
            out.append(("other", [], text, node.end_lineno))
    return [(k, n, t) for k, n, t, _ in out]


def record(code):
    """Called by the session with every piece of code it runs, before running it."""
    try:
        found = blocks(code)
    except (SyntaxError, ValueError):
        return
    for kind, names, text in found:
        if kind in ("def", "class", "import", "value", "star"):
            for n in names:
                # importing a tool by the name of a function written here keeps the function: the whole step is
                # recorded before it runs, so a save above the import in the same step still finds it
                if kind == "import" and re.match(r"\s*from\s+tools\.", text) and _src.get(n, [""])[0] in ("def", "class"):
                    continue
                _src[n] = [kind, text]
        if kind == "def":
            # a name set only by a `global` statement inside a function comes with that function
            node = ast.parse(text).body[0]
            for g in {n for s in ast.walk(node) if isinstance(s, ast.Global) for n in s.names}:
                if _src.get(g, ["global"])[0] == "global":
                    _src[g] = ["global", names[0]]
    if _drafts:
        try:
            os.makedirs(os.path.dirname(_drafts), exist_ok=True)
            tmp = _drafts + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(_src, f)
            os.replace(tmp, _drafts)
        except OSError:
            pass


def needs(text):
    """Global names some code reads, at any depth (bytecode, so `d.items()` and local variables don't count),
    minus what a class body sets for itself."""
    out = set()

    def walk(code):
        own = {i.argval for i in dis.get_instructions(code) if i.opname == "STORE_NAME"}
        for i in dis.get_instructions(code):
            if i.opname in LOADS and not (i.opname != "LOAD_GLOBAL" and i.argval in own and code.co_name != "<module>"):
                out.add(i.argval)
        for c in code.co_consts:
            if isinstance(c, types.CodeType):
                walk(c)

    walk(compile(text, "<tool>", "exec"))
    return {n for n in out if not (n.startswith("__") and n.endswith("__"))}  # __annotations__ and the like


# ---- the toolset folders ----

def _path(bucket, area):
    return os.path.join(W, bucket, "toolset", f"{area}.py")


def _find(area, buckets=BUCKETS):
    for b in buckets:
        if os.path.isfile(_path(b, area)):
            return b, _path(b, area)
    return None, None


def _areas(buckets=BUCKETS):
    found = {}
    for b in reversed(buckets):  # own bucket last, so it wins
        d = os.path.join(W, b, "toolset")
        if os.path.isdir(d):
            for e in sorted(os.listdir(d)):
                if e.endswith(".py") and AREA.match(e[:-3]):
                    found[e[:-3]] = (b, os.path.join(d, e))
    return found


def _defined(path):
    """Top-level names a toolset file defines, from its text."""
    try:
        with open(path, encoding="utf-8") as f:
            return {n for k, names, _ in blocks(f.read()) if k in ("def", "class", "value") for n in names}
    except (OSError, SyntaxError, ValueError):
        return set()


_WORK_WORD = re.compile(r"(?<![\w.~/-])/work(?=$|[\s/\"';:)|&<>,}\]])", re.M)


def _source(path):
    with open(path, encoding="utf-8") as f:
        src = f.read()
    # saved files say /work; on a person's own computer that's a folder in their home (same rule as emplio._load)
    return _WORK_WORD.sub(lambda _: W, src) if W != "/work" else src


class _Loader(importlib.abc.Loader):
    def __init__(self, path, area, bucket):
        self.path, self.area, self.bucket = path, area, bucket

    def create_module(self, spec):
        return None

    def exec_module(self, mod):
        mod.__emplio__ = f"tools {self.area} ({self.bucket}/toolset/{self.area}.py)"
        exec(compile(_source(self.path), self.path, "exec"), mod.__dict__)
        for name, _, _, risk in _tools_in(self.path):
            if risk in ("changes", "spends") and callable(mod.__dict__.get(name)):
                mod.__dict__[name] = _guard(self.area, name, risk, mod.__dict__[name])


_allowed = threading.local()  # inside a tool that was allowed: what it calls runs without asking again


def _guard(area, name, risk, fn):
    """A tool that changes things or spends money asks the person's OK (emplio tools allow) before it runs, the way
    app actions do: no card needed (Just do it, Always allow) and it runs now; a card, and it runs after this step
    once they allow it, so it returns a Pending here."""
    import functools

    @functools.wraps(fn)
    def guarded(*args, **kwargs):
        # outside Emplio's commands (a test, a check), in a run Emplio started once it was allowed, or inside one
        if not os.environ.get("EZ_KEY") or getattr(_allowed, "on", False):
            return fn(*args, **kwargs)
        if os.environ.get("EMPLIO_TOOL_OK") != f"{area}.{name}":
            from . import Pending, _run
            said = {"args": list(args), "kwargs": kwargs, "risk": risk}
            answer = _run(["tools", "allow", f"{area}.{name}", json.dumps(said, default=str, ensure_ascii=False)])
            if isinstance(answer, Pending):
                return answer
        # what an allowed tool calls is part of what was allowed
        _allowed.on = True
        try:
            return fn(*args, **kwargs)
        finally:
            _allowed.on = False

    guarded.__emplio_risk__ = risk
    return guarded


class _Finder(importlib.abc.MetaPathFinder):
    """`import tools.<area>`: the area's file in the toolset folders, own bucket first."""

    def find_spec(self, name, path=None, target=None):
        if name == "tools":
            spec = importlib.util.spec_from_loader("tools", loader=None, is_package=True)
            spec.submodule_search_locations = []
            return spec
        if name.startswith("tools.") and name.count(".") == 1:
            bucket, file = _find(name[6:])
            if file:
                return importlib.util.spec_from_file_location(name, file, loader=_Loader(file, name[6:], bucket))
        return None


def install():
    if not any(isinstance(f, _Finder) for f in sys.meta_path):
        sys.meta_path.insert(0, _Finder())


def forget(area=None):
    """Drop loaded areas so the next import reads the file again (after a save or an edit)."""
    for n in [n for n in sys.modules if n.startswith("tools.") and (area is None or n == f"tools.{area}")]:
        del sys.modules[n]


# ---- listing ----

def _tools_in(path):
    """(name, signature, first line of its docstring, risk) for each labelled function in a toolset file."""
    try:
        with open(path, encoding="utf-8") as f:
            tree = ast.parse(f.read())
    except (OSError, SyntaxError, ValueError):
        return []
    text = open(path, encoding="utf-8").read().splitlines()
    out = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith("_"):
            first = min([node.lineno] + [d.lineno for d in node.decorator_list])
            above = text[first - 2] if first > 1 else ""
            risk = RISK_LINE.match(above.strip())
            if not risk:
                continue
            args = ast.unparse(node.args)
            doc = (ast.get_docstring(node) or "(no description)").strip().split("\n")[0]
            out.append((node.name, f"{node.name}({args})", doc, risk.group(1).lower()))
    return out


def listing(words=None, buckets=BUCKETS):
    # any of the words, best match first: a search names the case ("reddit signed in") and a tool the general job
    # ("check_signed_in"), so all-words missed it. Short words (in, to, a) don't count.
    words = [w for w in re.split(r"[^a-z0-9]+", (words or "").lower()) if len(w) > 2]
    found = []
    for area, (bucket, path) in sorted(_areas(buckets).items()):
        for name, sig, doc, risk in _tools_in(path):
            hay = re.sub(r"[^a-z0-9]+", " ", f"{area} {name} {doc}".lower())
            hits = sum(w in hay for w in words)
            if words and not hits:
                continue
            found.append((-hits, f"  tools.{area}.{sig}: {doc} [{RISKS.get(risk, risk)}{'' if bucket == 'company' else ', ' + bucket}]"))
    return [line for _, line in sorted(found, key=lambda f: f[0])]


# ---- saving ----

def _default_bucket():
    # restricted/ is only there for owners and admins, who also write company/; a member's own tools go in me/
    return "company" if os.path.isdir(os.path.join(W, "restricted")) else "me"


def _check(path, target, kind):
    """Load a toolset file in a fresh Python (with the tools folders, as the session has them)."""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    prog = (
        "import sys, types\n"
        f"sys.path.insert(0, {here!r})\n"
        "import emplio\n"
        "mod = types.ModuleType('tools_check')\n"
        f"exec(compile(emplio._toolset._source({path!r}), {path!r}, 'exec'), mod.__dict__)\n"
        f"assert callable(getattr(mod, {target!r}, None)), 'it does not define {target}'\n"
    )
    try:
        done = subprocess.run([sys.executable, "-c", prog], capture_output=True, text=True, timeout=60, env={**os.environ, "EMPLIO_WORK": W})
    except subprocess.TimeoutExpired:
        return "loading it takes over a minute: do the work inside functions, not at the top of the file"
    if done.returncode:
        return (done.stderr.strip().splitlines() or ["(no message)"])[-1]
    return None


def _bare(text):
    return "\n".join(l for l in text.strip().split("\n") if not RISK_LINE.match(l.strip())).strip()


def save(fn, area, risk="reads", bucket=None, replace=False):
    """Keep a function (or class) from this session as a tool: tools.<area>.<name>. risk says what calling it
    does: "reads" (only looks things up), "changes" (writes, sends, deletes) or "spends" (money). It brings what
    it needs; a function that's already in another area is linked, not copied. replace=True lets it overwrite a
    different helper of the same name already in the area's file."""
    name = fn if isinstance(fn, str) else getattr(fn, "__name__", None)
    if not isinstance(name, str):
        raise ToolError("save a function you defined: emplio.tools.save(my_function, area=\"gmail\")")
    area = re.sub(r"[-\s]+", "_", (area or "").strip().lower())  # website-login → website_login, as Python can import it
    if not AREA.match(area) or keyword.iskeyword(area) or area in ("tools", "emplio"):
        raise ToolError(f"area {area!r}: one lower-case word or words_with_underscores, for what the tools are about (gmail, billing, reddit)")
    if risk not in RISKS:
        raise ToolError(f"risk {risk!r}: say \"reads\" (only looks things up), \"changes\" (writes, sends or deletes) or \"spends\" (money)")
    bucket = bucket or _default_bucket()
    if bucket not in BUCKETS:
        raise ToolError(f"bucket {bucket!r}: \"company\" (everyone), \"restricted\" (admins only) or \"me\" (only you)")
    if not os.path.isdir(os.path.join(W, bucket)):
        raise ToolError(f"there is no {bucket}/ folder here: save it in \"me\" or \"company\"")
    if bucket == "company" and _default_bucket() == "me":
        # a member's company/ is read-only (only inbox/ goes back): a save there would be lost
        raise ToolError("company tools are the owner's and admins' to keep: save it in \"me\" (only you), and propose it for everyone in company/inbox/")
    kind = _src.get(name, [""])[0]
    if kind not in ("def", "class"):
        raise ToolError(f"{name} wasn't defined in this session: define it (def {name}(...)) and run it once, then save it")
    if name.startswith("_"):
        raise ToolError(f"{name}: a tool's name can't start with _ (that marks a private helper)")
    if kind == "def" and not ast.get_docstring(ast.parse(_src[name][1]).body[0]):
        raise ToolError(f"give {name} a one-line docstring saying what it does: it's how the tool is listed and found")

    path = _path(bucket, area)
    existing = open(path, encoding="utf-8").read() if os.path.isfile(path) else ""
    try:
        old = blocks(existing)
    except SyntaxError as e:
        raise ToolError(f"{bucket}/toolset/{area}.py has a mistake on line {e.lineno} ({e.msg}): fix it first")
    in_file = {n for k, names, _ in old if k in ("def", "class", "value") for n in names}
    other = {a: (b, p) for a, (b, p) in _areas(OPEN[bucket]).items() if a != area}

    order, seen, refused, unknown, linked = [], set(), [], [], {}

    def elsewhere(n):  # another area that already has n as a public function or class
        if n.startswith("_"):
            return None
        for a, (b, p) in other.items():
            if n in _defined(p):
                return a
        return None

    def visit(n):  # depth first: what a piece needs comes before it
        if n in seen:
            return
        seen.add(n)
        if n != name:
            a = elsewhere(n)
            if a and _src.get(n, ["import"])[0] in ("def", "class", "import"):
                linked.setdefault(a, []).append(n)
                return
        k, text = _src[n]
        if k == "global":
            return visit(text)
        if k == "import":
            if re.match(rf"\s*from\s+tools\.{area}\s+import\b|\s*import\s+tools\.{area}\b", text):
                return  # the same area: those names are in the file already
            order.append(("import", n))
            return
        if k == "value" and not n.isupper():
            refused.append(n)
            return
        if k in ("def", "class", "value"):
            for m in sorted(needs(text) - {n}):
                if m in _src:
                    visit(m)
                elif m in GIVEN:
                    order.append(("given", m))
                elif m in in_file:
                    continue
                elif not hasattr(builtins, m):
                    a = elsewhere(m)
                    if a:
                        linked.setdefault(a, []).append(m)
                    elif not any(k2 == "star" for k2, _ in _src.values()):
                        unknown.append(m)
        if k == "star":
            return
        order.append((k, n))

    for n, (k, _) in list(_src.items()):
        if k == "star":
            order.append(("star", n))
    visit(name)
    if refused:
        raise ToolError(f"{name} uses {', '.join(sorted(set(refused)))} from earlier in this session (a value, not code): pass it in as an input, or name it in CAPS if it's a fixed setting, then save again")
    if unknown:
        raise ToolError(f"{name} uses {', '.join(sorted(set(unknown)))}, which isn't defined anywhere in this session: define it or fix the name, then save again")

    new_imports = list(dict.fromkeys(
        [_src[n][1] if k != "given" else GIVEN[n] for k, n in order if k in ("import", "star", "given")]
        + [f"from tools.{a} import {', '.join(sorted(set(ns)))}" for a, ns in sorted(linked.items())]
    ))
    new_blocks = {}
    for k, n in order:
        if k in ("def", "class", "value"):
            text = _src[n][1]
            if n == name:
                body = text.split("\n")
                while body and RISK_LINE.match(body[0].strip()):
                    body.pop(0)
                text = "\n".join([f"# risk: {risk}"] + body)
            new_blocks.setdefault(text, n)
    by_name = {n: t for t, n in new_blocks.items()}
    # a helper that's already in the file as it is (risk label aside) stays as it is, label and all
    for k, names, t in old:
        for n in names:
            if n in by_name and n != name and _bare(t) == _bare(by_name[n]):
                by_name[n] = t

    clash = [n for k, names, t in old if k in ("def", "class", "value") for n in names
             if n in by_name and n != name and _bare(t) != _bare(by_name[n])]
    if clash and not replace:
        raise ToolError(f"{area}.py already has a different {', '.join(clash)}, which other tools there may use: rename yours, or save again with replace=True to change it for all of them")

    doc = next((t for k, _, t in old if k == "doc"), f'"""{area.replace("_", " ").capitalize()} tools."""')
    imports = list(dict.fromkeys([t for k, _, t in old if k in ("import", "star")] + new_imports))
    body, placed = [], set()
    for k, names, t in old:
        if k in ("doc", "import", "star"):
            continue
        hit = [n for n in names if n in by_name]
        if hit and k in ("def", "class", "value"):
            t = by_name[hit[0]]
            placed.update(hit)
        body.append(t)
    fresh = [(n, by_name[n]) for t, n in new_blocks.items() if n not in placed]
    # new pieces go at the end, unless something already in the file now uses them: then just before it
    wanted = [i for i, t in enumerate(body) if needs(t) & {n for n, _ in fresh}]
    at = wanted[0] if wanted else len(body)
    body[at:at] = [t for _, t in fresh]
    text = doc + "\n" + ("\n".join(imports) + "\n\n\n" if imports else "\n\n") + "\n\n\n".join(body).rstrip() + "\n"
    if W != "/work":
        text = text.replace(W, "/work")

    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".saving"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    problem = _check(tmp, name, kind)
    if problem:
        os.remove(tmp)
        raise ToolError(f"not saved: {bucket}/toolset/{area}.py wouldn't load with it ({problem}). Fix {name} or what it uses, then save again")
    os.replace(tmp, path)
    forget(area)
    took = [n for t, n in new_blocks.items() if n != name]
    note = []
    if took:
        note.append(f"with {', '.join(took)}")
    if linked:
        note.append("using " + ", ".join(f"tools.{a}.{n}" for a, ns in sorted(linked.items()) for n in sorted(set(ns))))
    return f"Saved tool {area}.{name} ({RISKS[risk]}) in {bucket}/toolset/{area}.py" + (f", {'; '.join(note)}" if note else "") + f". Use it: from tools.{area} import {name}"


class Tools:
    """The tools kept so far: one file per area in the toolset folders. `from tools.gmail import send`, or
    emplio.tools.gmail.send(...). emplio.tools.list() shows them all, emplio.tools.search("words") finds some,
    emplio.tools.save(fn, area=..., risk=...) keeps one you wrote."""

    def __getattr__(self, area):
        if area.startswith("_"):
            raise AttributeError(area)
        if not _find(area)[1]:
            raise ToolError(f"no tools in area {area!r}. Areas: {', '.join(_areas()) or '(none yet)'}")
        import importlib
        return importlib.import_module(f"tools.{area}")

    def save(self, fn, area, risk="reads", bucket=None, replace=False):
        msg = save(fn, area, risk, bucket, replace)
        print(msg)
        return msg

    def list(self, area=None):
        """Every tool, with what it takes, what it's for and what calling it does."""
        lines = [l for l in listing() if area is None or l.startswith(f"  tools.{area}.")]
        print("Tools:\n" + "\n".join(lines) if lines else "No tools saved yet.")

    def search(self, words):
        """Tools whose area, name or description has all these words."""
        lines = listing(words)
        print("\n".join(lines) if lines else f"No tool matches {words!r}. emplio.tools.list() shows them all.")

    def _help(self):
        return (self.__doc__ or "") + "\n\n" + ("\n".join(listing()) or "No tools saved yet.")

    def __repr__(self):
        return "<emplio tools: help(emplio.tools) lists them>"


Tools.save.__doc__ = save.__doc__
