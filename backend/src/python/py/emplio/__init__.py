"""Emplio's own commands, from Python.

Every `emplio <area> <command> ...` is `emplio.<area>.<command>(...)`: words and values in order, `--flag value` as
flag=value (flag=True for a bare --flag), and what the command reads on stdin (a brief, a list, SQL) as input="...".
A JSON argument can be a dict or list. Answers come straight back: JSON as Python data, anything else as text.
A failure raises EmplioError with the server's own message (it names what does exist). help(emplio.apps) shows an
area's commands, help(emplio) all of them.

    rows = emplio.apps.run("googlesheets.get_values", {"spreadsheet_id": sid, "range": "A1:F200"})
    emplio.tasks.add("Send Acme the revised quote", to="raj@example.com", due="2026-10-25")
    emplio.hand("Researcher", input="Find three suppliers of ...")
    inv = emplio.skill("zoho-invoices"); inv.create("Acme", 12000)
    gst = emplio.lib("gst")
    results = emplio.map(inv.create, rows, limit=5)
"""
import importlib.util, json, os, re, shutil, subprocess, sys, threading
from concurrent.futures import ThreadPoolExecutor

__all__ = ["EmplioError", "ShellError", "Failed", "sh", "skill", "lib", "map", "help"]

W = os.environ.get("EMPLIO_WORK") or "/work"


class EmplioError(Exception):
    """An Emplio command failed; the message is the server's own, naming what to do instead."""


class ShellError(Exception):
    """A shell command (sh) exited with an error; the message has its exit code and output."""


def _bash():
    if os.name != "nt":
        return "/bin/bash" if os.path.exists("/bin/bash") else (shutil.which("bash") or "bash")
    return shutil.which("bash") or "bash"


def _fake(payload):
    # the evals' stand-in computer (evals/code/fake.py): nothing runs, a case answers
    import urllib.request
    req = urllib.request.Request(os.environ["EMPLIO_FAKE"], data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def sh(command, check=True, timeout=None, input=None):
    """Run a shell command (bash, on every computer) and return its output (stdout and stderr together) as text.
    A failing command raises ShellError unless check=False."""
    if os.environ.get("EMPLIO_FAKE"):
        got = _fake({"sh": command, "stdin": input})
        out, code = got["out"], got.get("code", 0)
        if check and code:
            raise ShellError(f"exit {code}: {out.strip() or '(no output)'}\n(command: {command[:300]})")
        return out
    done = subprocess.run([_bash(), "-c", command], input=input, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    out = done.stdout[:-1] if done.stdout.endswith("\n") else done.stdout
    if check and done.returncode:
        raise ShellError(f"exit {done.returncode}: {out.strip() or '(no output)'}\n(command: {command[:300]})")
    return out


def _cli():
    if os.name != "nt":
        return [shutil.which("emplio") or "emplio"]
    cmd = shutil.which("emplio.cmd") or shutil.which("emplio")
    script = os.path.join(os.path.dirname(cmd), "emplio") if cmd else "emplio"
    return [_bash(), script]


def _word(v):
    if isinstance(v, (dict, list, tuple)):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def _words(path, args, flags):
    words = list(path) + [_word(a) for a in args]
    for k, v in flags.items():
        if v is None or v is False:
            continue
        flag = "--" + k.rstrip("_").replace("_", "-")
        if v is True:
            words.append(flag)
        elif isinstance(v, (list, tuple)) and k in ("skills",):
            words += [flag, ",".join(str(x) for x in v)]
        else:
            words += [flag, _word(v)]
    return words


def _tags():
    key = os.environ.get("EZ_KEY", "")
    return re.compile(r"^([A-Z]+):" + re.escape(key) + r"\t") if key else None


class Pending(str):
    """A request the server finishes after this run (a hand-off, or something that needs the person's OK first):
    its answer shows below this run's output, not here. Don't build later steps on it in the same run."""


def _parse(text):
    t = text.strip()
    if not t:
        return ""
    if t[0] in "[{" or t in ("null", "true", "false") or re.fullmatch(r"-?\d+(\.\d+)?", t):
        try:
            return json.loads(t)
        except ValueError:
            pass
    m = re.match(r"Result is [\d,]+ characters, saved in full to (\S+?)\s", t)
    if m:
        path = m.group(1).rstrip(".")
        if W != "/work" and path.startswith("/work/"):
            path = W + path[5:]
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            pass
    return text


def _run(words, input=None):
    """One emplio command; its answer as Python data or text."""
    if os.environ.get("EMPLIO_FAKE"):
        got = _fake({"args": words, "stdin": input})
        done = subprocess.CompletedProcess(words, got.get("code", 0), got["out"], "")
    else:
        # EMPLIO_DATA: the server answers with data (rows, results, lists as JSON), not text written for reading
        done = subprocess.run(_cli() + words, input=input if input is not None else "", stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", env={**os.environ, "EMPLIO_DATA": "1"})
    tag = _tags()
    kept, later = [], []
    for line in done.stdout.split("\n"):
        (later if tag and tag.match(line) else kept).append(line)
    if later:
        # finished by the server once this run ends: the marker goes in the output for it to fill in
        print("\n".join(later), flush=True)
    text = "\n".join(kept).strip("\n")
    err = done.stderr.strip()
    asked = words[-1:] == ["help"]  # help asked for is an answer, not a mistake
    if (done.returncode and not asked) or text.lstrip().startswith("error:") or (text.lstrip().startswith("usage:") and not asked):
        raise EmplioError((text + ("\n" + err if err else "")).strip() or f"emplio {' '.join(words[:2])} failed (exit {done.returncode})")
    if later and not text.strip():
        return Pending(f"emplio {' '.join(words[:2])}: its answer comes after this run, below the output.")
    if err:
        print(err, file=sys.stderr)
    return _parse(text)


# commands that read stdin only after a "-", and how many words come before it
_STDIN_AFTER = {("db", "sql"): 0, ("db", "script"): 0, ("automations", "add"): 1, ("automations", "update"): 1, ("apps", "run"): 1, ("mcp", "call"): 2}


class _Area:
    """An area of emplio commands. Call it, or a command in it, with the command's words and values."""

    def __init__(self, path):
        self._path = path

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return _Area(self._path + [name.rstrip("_").replace("_", "-")])

    def __call__(self, *args, input=None, **flags):
        # input= needs no "-" (the command line's "read it from stdin"): it goes after the command's own words
        if input is not None and len(args) == _STDIN_AFTER.get(tuple(self._path), -1):
            args = (*args, "-")
        # a checklist's steps as one list (emplio.plan.set([...])): each its own step, not one step of JSON
        if self._path[:1] == ["plan"] and len(args) == 1 and isinstance(args[0], (list, tuple)):
            args = tuple(args[0])
        return _run(_words(self._path, args, flags), input)

    def __repr__(self):
        return f"<emplio {' '.join(self._path)}: help(emplio.{'.'.join(self._path)}) shows how>"

    def _help(self):
        try:
            return str(_run(self._path + ["help"]))
        except EmplioError as e:
            return str(e)


def help(*path):
    """What emplio can do: emplio.help() for every area, emplio.help("apps") for one."""
    print(_Area(list(path))._help() if path else _usage())


def _usage():
    if os.environ.get("EMPLIO_FAKE"):
        return _fake({"args": ["help"], "stdin": None})["out"]
    done = subprocess.run(_cli() + ["help"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    return done.stdout.strip()


# ---- saved functions ----

_loaded = {}
# "/work" as a word of its own, not part of another path (a/work, ~/work, /workspace)
_WORK_WORD = re.compile(r"(?<![\w.~/-])/work(?=$|[\s/\"';:)|&<>,}\]])", re.M)


def _load(kind, name, paths):
    for path in paths:
        if os.path.isfile(path):
            mtime = os.path.getmtime(path)
            hit = _loaded.get(path)
            if hit and hit[0] == mtime:
                return hit[1]
            safe = re.sub(r"\W", "_", name)
            spec = importlib.util.spec_from_file_location(f"emplio_{kind}_{safe}", path)
            mod = importlib.util.module_from_spec(spec)
            mod.__emplio__ = f"{kind} {name}"
            with open(path, encoding="utf-8") as f:
                src = f.read()
            # on a person's own computer /work is a folder in their home: the app swaps it in what Emplio types, and
            # here in saved files, so a skill saved on one computer works on the other (same rule as desktop paths.js)
            if W != "/work":
                src = _WORK_WORD.sub(lambda _: W, src)
            exec(compile(src, path, "exec"), mod.__dict__)
            _loaded[path] = (mtime, mod)
            return mod
    where = " or ".join(p.replace(W, "/work", 1) for p in paths)
    raise EmplioError(f"no {kind} {name}: nothing at {where}. Saved ones: {', '.join(_names(kind)) or '(none yet)'}")


def _names(kind):
    found = set()
    for top in ("me", "company"):
        if kind == "skill":
            d = os.path.join(W, top, "skills")
            if os.path.isdir(d):
                found |= {e for e in os.listdir(d) if os.path.isfile(os.path.join(d, e, "functions.py"))}
        else:
            d = os.path.join(W, top, "lib")
            if os.path.isdir(d):
                found |= {e[:-3] for e in os.listdir(d) if e.endswith(".py")}
    return sorted(found)


def skill(name):
    """A skill's saved functions (skills/<name>/functions.py; this person's own first, then the company's)."""
    return _load("skill", name, [os.path.join(W, top, "skills", name, "functions.py") for top in ("me", "company")])


def lib(name):
    """Shared helper functions used by several skills (lib/<name>.py; this person's own first, then the company's)."""
    return _load("lib", name, [os.path.join(W, top, "lib", name + ".py") for top in ("me", "company")])


def describe(mod):
    """Each public function of saved functions, with its inputs and one-line description."""
    import inspect
    lines = [f"{mod.__emplio__}:"]
    for n, f in vars(mod).items():
        if callable(f) and not n.startswith("_") and inspect.isfunction(f) and f.__module__ == mod.__name__:
            doc = (inspect.getdoc(f) or "(no description)").split("\n")[0]
            lines.append(f"  {n}{inspect.signature(f)}: {doc}")
    return "\n".join(lines)


# ---- many at once ----

class Failed:
    """One item of emplio.map that failed: .item is what it was given, .error what went wrong."""

    def __init__(self, item, error):
        self.item, self.error = item, error

    def __bool__(self):
        return False

    def __repr__(self):
        return f"Failed({self.item!r}: {self.error})"


def map(fn, items, limit=5):
    """fn over every item, up to `limit` at a time; results in the same order. A failure doesn't stop the rest: its
    place holds a Failed (falsy, with .item and .error). A dict or tuple item is passed as keyword/positional args."""
    items = list(items)

    def one(item):
        try:
            if isinstance(item, dict):
                return fn(**item)
            if isinstance(item, tuple):
                return fn(*item)
            return fn(item)
        except Exception as e:  # noqa: BLE001 -- each failure is reported in its place
            return Failed(item, e)

    # stopped (time ran out, or interrupted): what hasn't started is dropped, not left running after the run
    pool = ThreadPoolExecutor(max_workers=max(1, min(int(limit), 10)))
    try:
        return list(pool.map(one, items))
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


_root = _Area([])


def __getattr__(name):
    # emplio.apps, emplio.tasks, emplio.hand ...: every area the command line has
    if name.startswith("__"):
        raise AttributeError(name)
    return getattr(_root, name)
