#!/usr/bin/env python3
# Emplio's Python session: one per chat (and per job), kept running between the AI's steps so what it loaded stays
# loaded, like a notebook. The server runs `python3 kernel.py run <session> [--restart]` with the code on stdin; this
# client starts the session when there's none (or it's from an older Emplio), hands it the code with this command's
# environment, and prints what the code printed. `once` runs code in a fresh process (background runs).
# Standard library only: it runs on the cloud computer, a Mac and Windows alike.
import ast, builtins, json, linecache, os, re, signal, socket, subprocess, sys, threading, time, traceback, _thread

VERSION = "1"
HERE = os.path.dirname(os.path.abspath(__file__))
W = os.environ.get("EMPLIO_WORK") or "/work"
SESSIONS = os.path.join(W, "tmp", ".emplio", "sessions")
IDLE_S = 45 * 60
MAX_OUT = 5 * 1024 * 1024
sys.path.insert(0, os.path.join(HERE, "py"))
# libraries installed for a person's own computer, whose Python Emplio can't change (sandbox.ts PY_SITE)
sys.path.append(os.path.join(W, "tmp", ".emplio", "site"))


def send(conn, obj):
    data = json.dumps(obj).encode()
    conn.sendall(len(data).to_bytes(4, "big") + data)


def recv(conn):
    head = b""
    while len(head) < 4:
        chunk = conn.recv(4 - len(head))
        if not chunk:
            return None
        head += chunk
    size, data = int.from_bytes(head, "big"), b""
    while len(data) < size:
        chunk = conn.recv(min(1 << 16, size - len(data)))
        if not chunk:
            return None
        data += chunk
    return json.loads(data)


# ---- what the code is run with ----

def fresh_namespace():
    # the evals' stand-in computer, when they run this (evals/code/fake.py)
    if os.environ.get("EMPLIO_FAKE_LIB"):
        sys.path.insert(0, os.path.dirname(os.environ["EMPLIO_FAKE_LIB"]))
        import fake  # noqa: F401
    import emplio
    from emplio import sh
    from pathlib import Path
    plain = builtins.help

    def help(obj=None, *more):
        # emplio's areas and saved functions answer with Emplio's own words; anything else as Python would
        if obj is emplio:
            return emplio.help()
        if isinstance(obj, emplio._Area):
            return print(obj._help())
        if getattr(obj, "__emplio__", None):
            return print(emplio.describe(obj))
        return plain(obj, *more) if obj is not None else plain()

    return {"__name__": "__main__", "__builtins__": builtins, "emplio": emplio, "sh": sh, "help": help, "json": json, "os": os, "re": re, "sys": sys, "Path": Path}


# saved functions: skills' functions.py and the shared lib/ files, checked when a run changes them
def saved_files():
    found = {}
    for top in ("company", "me"):
        for pattern_dir, name in ((os.path.join(W, top, "skills"), "functions.py"), (os.path.join(W, top, "lib"), None)):
            if not os.path.isdir(pattern_dir):
                continue
            for entry in os.listdir(pattern_dir):
                path = os.path.join(pattern_dir, entry, name) if name else os.path.join(pattern_dir, entry)
                if path.endswith(".py") and os.path.isfile(path):
                    try:
                        found[path] = os.path.getmtime(path)
                    except OSError:
                        pass
    return found


def check_saved(path):
    rel = "/work" + path[len(W):] if path.startswith(W) else path
    # on a person's own computer /work is a folder in their home: a saved file says /work, never that folder, so it
    # works on the cloud computer too (emplio._load swaps it back here)
    if W != "/work":
        try:
            text = open(path, encoding="utf-8").read()
            if W in text:
                with open(path, "w", encoding="utf-8") as f:
                    f.write(text.replace(W, "/work"))
        except OSError:
            pass
    try:
        tree = ast.parse(open(path, encoding="utf-8").read(), path)
    except SyntaxError as e:
        return f"{rel} has a mistake on line {e.lineno}: {e.msg}. It can't be used until it's fixed."
    bare = [n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and not n.name.startswith("_") and not ast.get_docstring(n)]
    try:
        done = subprocess.run([sys.executable, "-c", "import runpy,sys; sys.path.insert(0, sys.argv[2]); runpy.run_path(sys.argv[1])", path, os.path.join(HERE, "py")], capture_output=True, text=True, timeout=60)
        if done.returncode:
            last = (done.stderr or done.stdout).strip().splitlines()[-1:] or ["(no message)"]
            return f"{rel} doesn't load: {last[0]}. Fix it before you finish."
    except subprocess.TimeoutExpired:
        return f"{rel} takes over a minute just to load: do the work inside functions, not at the top of the file."
    if bare:
        return f"{rel}: give {', '.join(bare)} a one-line description (a docstring), so help() shows what each is for."
    return None


def trimmed(exc):
    # only the lines of the AI's own code and saved functions, then the message: the rest is Emplio's and Python's
    from emplio import EmplioError, ShellError
    if isinstance(exc, SyntaxError) and exc.filename == "<code>":
        line = (exc.text or "").rstrip("\n")
        return f"SyntaxError on line {exc.lineno}: {exc.msg}\n    {line}"
    frames = [f for f in traceback.extract_tb(exc.__traceback__) if f.filename == "<code>" or "/skills/" in f.filename.replace("\\", "/") or "/lib/" in f.filename.replace("\\", "/")]
    where = []
    for f in frames[-3:]:
        place = "your code" if f.filename == "<code>" else ("/work" + f.filename[len(W):] if f.filename.startswith(W) else f.filename)
        where.append(f"  {place}, line {f.lineno}" + (f": {f.line}" if f.line else ""))
    kind = "" if isinstance(exc, (EmplioError, ShellError)) else f"{type(exc).__name__}: "
    return "\n".join(["Error" + (":" if where else ""), *where, f"{kind}{exc}"]) if where else f"{kind}{exc}"


def run_code(ns, code, interrupted=None):
    before = saved_files()
    status = 0
    linecache.cache["<code>"] = (len(code), None, code.splitlines(True), "<code>")
    try:
        exec(compile(code, "<code>", "exec"), ns)
    except KeyboardInterrupt:
        status = 130
        print("\n[Stopped before it finished: the time limit, or Stop. Variables set before that point are kept.]" if interrupted and interrupted() else "\nKeyboardInterrupt", file=sys.stderr)
    except SystemExit as e:
        status = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
        if e.code not in (None, 0) and not isinstance(e.code, int):
            print(e.code, file=sys.stderr)
    except BaseException as e:  # noqa: BLE001 -- the AI reads every failure
        status = 1
        print(trimmed(e), file=sys.stderr)
        # a name set in an earlier step that's gone: that step failed before setting it, or the session is new
        if isinstance(e, NameError):
            print("[Not set in this session: an earlier step that set it stopped at an error first, or this is a new session (another computer, or it ended). Set it again here; don't assume other earlier values are there either.]", file=sys.stderr)
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
    if "fake" in sys.modules:
        sys.modules["fake"].after_run()
    after = saved_files()
    notes = [n for n in (check_saved(p) for p, m in after.items() if before.get(p) != m) if n]
    if notes:
        print("\n[Saved functions: " + " ".join(notes) + "]")
    return status


# ---- the session ----

def serve(key):
    # started from a background command, SIGINT may come ignored: the stop below needs it
    signal.signal(signal.SIGINT, signal.default_int_handler)
    os.makedirs(SESSIONS, exist_ok=True)
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.bind(("127.0.0.1", 0))
    srv.listen(8)
    srv.settimeout(IDLE_S)
    token = os.urandom(16).hex()
    info = os.path.join(SESSIONS, key + ".json")
    with open(info + ".tmp", "w") as f:
        json.dump({"port": srv.getsockname()[1], "token": token, "pid": os.getpid(), "version": VERSION}, f)
    os.replace(info + ".tmp", info)
    ns = fresh_namespace()
    # everything the code prints, Python's or a program's it starts, goes through one pipe to the waiting client
    read_end, write_end = os.pipe()
    os.dup2(write_end, 1)
    os.dup2(write_end, 2)
    sys.stdout = open(1, "w", buffering=1, encoding="utf-8", errors="replace", closefd=False)
    sys.stderr = open(2, "w", buffering=1, encoding="utf-8", errors="replace", closefd=False)
    captured = []
    lock = threading.Lock()

    def drain():
        while True:
            chunk = os.read(read_end, 1 << 16)
            if not chunk:
                return
            with lock:
                if sum(map(len, captured)) < MAX_OUT:
                    captured.append(chunk)

    threading.Thread(target=drain, daemon=True).start()
    try:
        while True:
            try:
                conn, _ = srv.accept()
            except socket.timeout:
                return
            with conn:
                req = recv(conn)
                if not req or req.get("token") != token:
                    continue
                if req.get("stop"):
                    send(conn, {"ok": True})
                    return
                os.environ.clear()
                os.environ.update(req["env"])
                try:
                    os.chdir(req.get("cwd") or W)
                except OSError:
                    pass
                gone, running = threading.Event(), threading.Event()
                running.set()

                def watch(c=conn):
                    # the client went away (time limit, Stop) while the code runs: interrupt it where it is
                    try:
                        while c.recv(1):
                            pass
                    except OSError:
                        pass
                    if running.is_set():
                        gone.set()
                        # a real signal, so a wait inside a program it started (sh, subprocess) is cut short too
                        if os.name == "nt":
                            _thread.interrupt_main()
                        else:
                            os.kill(os.getpid(), signal.SIGINT)

                watcher = threading.Thread(target=watch, daemon=True)
                watcher.start()
                try:
                    status = run_code(ns, req["code"], gone.is_set)
                except KeyboardInterrupt:
                    status = 130
                running.clear()
                time.sleep(0.05)  # let the pipe empty
                with lock:
                    out = b"".join(captured)
                    captured.clear()
                try:
                    send(conn, {"status": status, "out": out.decode("utf-8", "replace")})
                    conn.shutdown(socket.SHUT_WR)
                except OSError:
                    pass
    finally:
        try:
            if json.load(open(info)).get("token") == token:
                os.remove(info)
        except (OSError, ValueError):
            pass


def alive(info):
    try:
        with socket.create_connection(("127.0.0.1", info["port"]), timeout=2):
            return True
    except OSError:
        return False


def stop(info):
    try:
        with socket.create_connection(("127.0.0.1", info["port"]), timeout=2) as c:
            send(c, {"token": info["token"], "stop": True})
            recv(c)
    except OSError:
        pass
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/pid", str(info["pid"]), "/T", "/F"], capture_output=True)
        else:
            os.kill(info["pid"], signal.SIGKILL)
    except (OSError, ProcessLookupError):
        pass


def start(key):
    path = os.path.join(SESSIONS, key + ".json")
    try:
        os.remove(path)
    except OSError:
        pass
    flags = {"creationflags": 0x00000008 | 0x00000200} if os.name == "nt" else {"start_new_session": True}
    subprocess.Popen([sys.executable, os.path.abspath(__file__), "serve", key], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True, **flags)
    for _ in range(200):
        try:
            info = json.load(open(path))
            if alive(info):
                return info
        except (OSError, ValueError):
            pass
        time.sleep(0.05)
    raise SystemExit("emplio: the Python session didn't start")


def client(key, restart):
    if not re.fullmatch(r"[\w.-]+", key):
        raise SystemExit("emplio: bad session name")
    code = sys.stdin.read()
    path = os.path.join(SESSIONS, key + ".json")
    note = ""
    try:
        info = json.load(open(path))
    except (OSError, ValueError):
        info = None
    if info and (restart or info.get("version") != VERSION or not alive(info)):
        if alive(info):
            stop(info)
        note = "[Restarted: a fresh Python session; variables from earlier steps are gone.]\n" if restart else "[A new Python session: the earlier one ended (idle, or the computer was replaced), so variables from earlier steps are gone. Load what you need again.]\n"
        info = None
    elif not info and restart:
        note = "[Restarted: a fresh Python session.]\n"
    if not info:
        info = start(key)
    c = socket.create_connection(("127.0.0.1", info["port"]))
    send(c, {"token": info["token"], "code": code, "env": dict(os.environ), "cwd": os.getcwd()})

    def quit_(*_):
        c.close()
        os._exit(130)

    for sig in (signal.SIGTERM, signal.SIGINT) + ((signal.SIGHUP,) if hasattr(signal, "SIGHUP") else ()):
        signal.signal(sig, quit_)
    done = recv(c)
    if done is None:
        why = ""
        try:
            why = open(os.path.join(SESSIONS, key + ".err")).read().strip().splitlines()[-1]
        except (OSError, IndexError):
            pass
        sys.stdout.write(note + f"[The Python session stopped while running this ({why or 'out of memory, or it crashed'}). The next run starts a fresh one.]\n")
        sys.exit(1)
    out = done["out"]
    sys.stdout.write(note + (out if out.strip() else ("(no output: print what you need to see)\n" if done["status"] == 0 else "")))
    sys.stdout.flush()
    sys.exit(done["status"] if isinstance(done["status"], int) else 1)


def once():
    # a background run: its own process, the same helpers, nothing kept
    sys.exit(run_code(fresh_namespace(), sys.stdin.read()))


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else ""
    if what == "serve":
        try:
            serve(sys.argv[2])
        except BaseException:
            # for the client to show: why the session ended
            with open(os.path.join(SESSIONS, sys.argv[2] + ".err"), "w") as f:
                f.write(traceback.format_exc())
            raise
    elif what == "run":
        client(sys.argv[2], "--restart" in sys.argv[3:])
    elif what == "once":
        once()
    else:
        raise SystemExit("usage: kernel.py run <session> [--restart] < code | once < code")
