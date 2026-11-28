# The evals' stand-in computer for code mode (../emplio.ts): the Python session runs for real, but /work is a scratch
# folder (EMPLIO_WORK), files there that the business "has" come from the case's stand-ins the first time they're read,
# and every file the code writes is reported to the eval as the command a shell would have run (cat > <path> <<'EOF'),
# so the same markers judge both modes. emplio commands and sh() are answered by the stand-ins too (emplio/__init__.py).
import builtins, io, json, os, urllib.request

W = os.environ["EMPLIO_WORK"]
_open, _stat, _listdir, _mkdir, _makedirs = builtins.open, os.stat, os.listdir, os.mkdir, os.makedirs
_remove, _replace, _rename = os.remove, os.replace, os.rename
import stat as _st


# the real checks, on the real os.stat (os.path's own call os.stat, patched below)
def _mode(r):
    try:
        return _stat(r).st_mode
    except (OSError, ValueError, TypeError):
        return None


def _exists(r):
    return _mode(r) is not None


def _isfile(r):
    m = _mode(r)
    return m is not None and _st.S_ISREG(m)


def _isdir(r):
    m = _mode(r)
    return m is not None and _st.S_ISDIR(m)
asked = set()


def ask(payload):
    req = urllib.request.Request(os.environ["EMPLIO_FAKE"], data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def real(p):
    if isinstance(p, int):
        return p
    p = os.fspath(p)
    if isinstance(p, bytes):
        return p
    return W + p[5:] if p == "/work" or p.startswith("/work/") else p


def shown(r):
    return "/work" + r[len(W):] if isinstance(r, str) and r.startswith(W) else r


def fetch(r):
    # a file the business has but this folder doesn't yet: from the stand-ins, once
    if not isinstance(r, str) or not r.startswith(W) or _exists(r) or r in asked or "/tmp/.emplio" in r:
        return
    # ponytail: a name with no dot is taken for a folder (company/knowledge), never made a file; Makefile-like names miss out
    if "." not in os.path.basename(r):
        return
    asked.add(r)
    try:
        got = ask({"read": shown(r)})["out"]
    except Exception:
        return
    if got and not got.startswith("cat:") and "No such file" not in got:
        _makedirs(os.path.dirname(r), exist_ok=True)
        if r.endswith(".xlsx"):
            # a spreadsheet a job made opens as one: a line per row, cells split by tabs (numbers as numbers)
            try:
                import openpyxl
                wb = openpyxl.Workbook()
                num = lambda c: int(c) if c.lstrip("-").isdigit() else c
                for line in got.splitlines():
                    wb.active.append([num(c) for c in line.split("\t")])
                wb.save(r)
                seen[r] = _stat(r).st_mtime
                return
            except ImportError:
                pass
        with _open(r, "w", encoding="utf-8") as f:
            f.write(got)
        seen[r] = _stat(r).st_mtime


def open_(file, mode="r", *a, **k):
    r = real(file)
    # read, and append too: an appended file starts from what's there, so the write the eval sees is the whole file
    if not any(c in mode for c in "wx"):
        fetch(r)
    if any(c in mode for c in "wax+") and isinstance(r, str) and r.startswith(W):
        _makedirs(os.path.dirname(r), exist_ok=True)
    return _open(r, mode, *a, **k)


def listdir(p="."):
    r = real(p)
    names = set(_listdir(r)) if _isdir(r) else set()
    if isinstance(r, str) and r.startswith(W) and r not in asked:
        asked.add(r)
        try:
            names |= {n for n in ask({"ls": shown(r)})["out"].split() if n}
        except Exception:
            pass
        _makedirs(r, exist_ok=True)
    return sorted(names)


def exists(p):
    r = real(p)
    fetch(r)
    return _exists(r) or (isinstance(r, str) and r.startswith(W) and _isdir(r))


def isfile(p):
    r = real(p)
    fetch(r)
    return _isfile(r)


builtins.open = io.open = open_
os.listdir = listdir
os.path.exists = exists
os.path.isfile = isfile
os.path.isdir = lambda p: _isdir(real(p))
os.stat = lambda p, *a, **k: (fetch(real(p)), _stat(real(p), *a, **k))[1]
os.mkdir = lambda p, *a, **k: _mkdir(real(p), *a, **k)
os.makedirs = lambda p, *a, **k: _makedirs(real(p), *a, **k)
os.remove = os.unlink = lambda p, *a, **k: _remove(real(p), *a, **k)
os.replace = lambda a, b, *x, **k: _replace(real(a), real(b), *x, **k)
os.rename = lambda a, b, *x, **k: _rename(real(a), real(b), *x, **k)

seen = {}


def snapshot():
    found = {}
    for root, dirs, files in os.walk(W):
        dirs[:] = [d for d in dirs if not (root == os.path.join(W, "tmp") and d == ".emplio")]
        for f in files:
            p = os.path.join(root, f)
            try:
                found[p] = _stat(p).st_mtime
            except OSError:
                pass
    return found


seen.update(snapshot())


def after_run():
    # each file this run wrote, to the eval as the shell command that would have written it
    for p, m in snapshot().items():
        if seen.get(p) == m:
            continue
        seen[p] = m
        try:
            text = _open(p, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        try:
            ask({"write": shown(p), "text": text})
        except Exception:
            pass
