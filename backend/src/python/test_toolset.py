"""emplio.tools against the real session (kernel.run_code): code goes in like the agent's steps, functions are
saved as tools, and each saved file is imported in a brand-new Python that must give the expected answer.
Run: python3 test_toolset.py (toolset.test.ts runs it with the other tests)."""
import os, shutil, subprocess, sys, tempfile, textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = tempfile.mkdtemp(prefix="toolset-")
os.environ["EMPLIO_WORK"] = WORK
sys.path[:0] = [HERE, os.path.join(HERE, "py")]
import kernel  # noqa: E402
import emplio  # noqa: E402

T = emplio._toolset
T.NEED_RETURNS = False  # the examples below are about saving; what a tool returns is checked at the end
FAILED = []


def reset(admin=True):
    shutil.rmtree(WORK)
    for d in ("company", "me", "tmp") + (("restricted",) if admin else ()):
        os.makedirs(os.path.join(WORK, d))
    T._src.clear()
    T.forget()


def session():
    T._src.clear()
    T.forget()
    return kernel.fresh_namespace()


def run(ns, code):
    status = kernel.run_code(ns, textwrap.dedent(code))
    assert status == 0, f"code failed: {code[:80]}"


def save(*a, **k):
    try:
        return T.save(*a, **k)
    except T.ToolError as e:
        return f"REFUSED {e}"


def fresh(area, expr):
    prog = f"import sys; sys.path.insert(0, {os.path.join(HERE, 'py')!r}); import emplio; from tools.{area} import *; print(repr({expr}))"
    r = subprocess.run([sys.executable, "-c", prog], capture_output=True, text=True, timeout=60, env={**os.environ})
    return r.stdout.strip() if r.returncode == 0 else "ERROR: " + (r.stderr.strip().splitlines() or ["?"])[-1]


def file(bucket, area):
    return open(os.path.join(WORK, bucket, "toolset", f"{area}.py"), encoding="utf-8").read()


def check(title, got, want):
    ok = (got.startswith("REFUSED") and want[8:] in got) if want.startswith("REFUSED") else (want in got) if want.startswith("Saved") or want.startswith("in ") else got == want
    print(f"{'ok  ' if ok else 'FAIL'} {title:<58} {got[:110]}")
    if not ok:
        FAILED.append(f"{title}: wanted {want!r}, got {got!r}")


def case(title, cells, saves, admin=True):
    """saves: (name, area, expr, expected) — expected 'REFUSED <text>' or the repr the fresh import prints."""
    reset(admin)
    ns = session()
    for c in cells:
        run(ns, c)
    for name, area, expr, want in saves:
        msg = save(name, area=area)
        if msg.startswith("REFUSED") or want.startswith("REFUSED"):
            check(f"{title} / {name}", msg, want)
        else:
            check(f"{title} / {name}", fresh(area, expr), want)
    return ns


# ---------- how the agent writes code ----------

MATH = ['''
    import math
    def add(a, b):
        """a + b"""
        return a + b
    def mul(a, b):
        """a × b"""
        return a * b
    def square(x):
        """x²"""
        return mul(x, x)
    def circle_area(r):
        """π r²"""
        return mul(math.pi, square(r))
    def ring_area(outer, inner):
        """Area between two circles."""
        def minus(a, b): return add(a, -b)
        return minus(circle_area(outer), circle_area(inner))
    ''']
case("math, one area", MATH, [("mul", "arith", "mul(2, 3)", "6"), ("add", "arith", "add(1, 2)", "3"),
                              ("ring_area", "arith", "round(ring_area(5, 3), 2)", "50.27"), ("square", "arith", "square(4)", "16")])
t = file("company", "arith")
assert t.count("def mul") == 1 and t.count("def add") == 1, t
assert t.count("# risk: reads") == 4, t

case("math, two areas link instead of copy", MATH, [("mul", "arith", "mul(2, 3)", "6"), ("add", "arith", "add(1, 2)", "3"),
                                                    ("ring_area", "geometry", "round(ring_area(5, 3), 2)", "50.27")])
t = file("company", "geometry")
assert "from tools.arith import add, mul" in t and "def mul" not in t and "def square" in t, t

case("five levels of inner functions", ['''
    STEP = 1
    def bump(x):
        """x + STEP"""
        return x + STEP
    def outer(n):
        """Nested on purpose."""
        def l2(a):
            def l3(b):
                def l4(c):
                    def l5(d): return bump(d) + n
                    return l5(c)
                return l4(b)
            return l3(a)
        return l2(n)
    '''], [("outer", "deep", "outer(10)", "21")])

case("decorator, defaults, constants", ['''
    import functools
    RATE = 3
    CALLS = []
    def logged(fn):
        @functools.wraps(fn)
        def wrap(*a, **k): CALLS.append(fn.__name__); return fn(*a, **k)
        return wrap
    def plain(x): return x
    @logged
    def scale(x, f=plain, k=RATE):
        """x scaled."""
        return f(x) * k
    '''], [("scale", "calc", "(scale(2), scale.__name__)", "(6, 'scale')")])

case("classes: diamond, class attributes, dataclass", ['''
    from dataclasses import dataclass, field
    TAX = 0.18
    class Base:
        def hi(self): return "base"
    class Left(Base):
        def hi(self): return "left+" + super().hi()
    class Right(Base):
        def hi(self): return "right+" + super().hi()
    class Both(Left, Right):
        rate = TAX
        double = rate * 2
    @dataclass
    class Grant:
        email: str
        lots: list = field(default_factory=list)
    def describe(g: Grant):
        """One line about a grant."""
        return f"{g.email} {Both().hi()} {Both.double}"
    '''], [("describe", "shapes", "describe(Grant('a@b.c'))", "'a@b.c left+right+base 0.36'")])

case("recursion, exceptions, async, generators", ['''
    import asyncio
    class NotFound(Exception): pass
    def find(d, k):
        if k not in d: raise NotFound(k)
        return d[k]
    def is_even(n): return True if n == 0 else is_odd(n - 1)
    def is_odd(n): return False if n == 0 else is_even(n - 1)
    def evens(n):
        for i in range(n):
            if is_even(i): yield i
    async def gather(n):
        await asyncio.sleep(0)
        return list(evens(n))
    def run_all(d, k, n):
        """Look up k, then even numbers below n."""
        try: v = find(d, k)
        except NotFound: v = None
        return v, asyncio.run(gather(n))
    '''], [("run_all", "misc", "run_all({}, 'x', 5)", "(None, [0, 2, 4])")])

case("attribute names and locals aren't session values", ['''
    items = [1, 2, 3]
    total = 999
    def pairs(d):
        """Sorted items and their sum."""
        total = sum(d.values())
        return sorted(d.items()), total
    '''], [("pairs", "misc", "pairs({'b': 2, 'a': 1})", "([('a', 1), ('b', 2)], 3)")])

case("latest definition wins", [
    'def greet(n):\n    """Hi."""\n    return "hi " + n',
    'def greet(n):\n    """Hello."""\n    return f"Hello, {n}!"  # second try',
], [("greet", "words", "greet('ash')", "'Hello, ash!'")])

case("session helpers (sh, json, Path) come with an import", ['''
    def dump(x):
        """x as JSON, and the name of a path."""
        return json.dumps(x), Path("/a/b.txt").name
    '''], [("dump", "misc", "dump({'a': 1})", "('{\"a\": 1}', 'b.txt')")])
assert "import json" in file("company", "misc") and "from pathlib import Path" in file("company", "misc")

case("global counter", ['''
    COUNT = 0
    def tick():
        """Counts calls."""
        global COUNT
        COUNT += 1
        return COUNT
    '''], [("tick", "misc", "(tick(), tick())", "(1, 2)")])

case("a value set by another function's global statement", ['''
    def set_key(path):
        """Where the key file is."""
        global KEY
        KEY = path
    def key_name():
        """The key file's name."""
        return KEY.split("/")[-1]
    '''], [("key_name", "keys", "(set_key('/a/k.pem'), key_name())[1]", "'k.pem'")])

case("comments and docstrings kept word for word", ['''
    # rupees to paise, never floats
    def paise(rupees):
        """Rupees (str or number) to whole paise."""
        from decimal import Decimal
        return int(Decimal(str(rupees)) * 100)  # exact
    '''], [("paise", "money", "paise('12.34')", "1234")])
t = file("company", "money")
assert "# rupees to paise, never floats" in t and "# exact" in t and t.index("# risk: reads") < t.index("def paise"), t

case("/work paths stay /work in the file", [f'''
    OUT = "{WORK}/out"
    def out_path(n):
        """Where a made file goes."""
        return OUT + "/" + n
    '''], [("out_path", "files", "out_path('a.txt')", repr(f"{WORK}/out/a.txt"))])
assert '"/work/out"' in file("company", "files")

# ---------- what must be refused ----------

case("leftover value refused", ['''
    email = "aakash@example.com"
    def grant():
        """Grant Pro."""
        return email
    '''], [("grant", "billing", "", "REFUSED grant uses email from earlier in this session")])
case("undefined name refused", ['''
    def broken(x):
        """Typo inside."""
        return helpr(x) if x > 100 else x
    '''], [("broken", "misc", "", "REFUSED isn't defined anywhere")])
case("no docstring refused", ["def bare(x): return x"], [("bare", "misc", "", "REFUSED one-line docstring")])
case("private name refused", ['def _hidden(x):\n    """x"""\n    return x'], [("_hidden", "misc", "", "REFUSED can't start with _")])
case("not from this session", ["x = 1"], [("nothing", "misc", "", "REFUSED wasn't defined in this session")])
reset()
ns = session()
run(ns, 'def f(x):\n    """x"""\n    return x')
check("bad area", save("f", area="9 lives.py"), "REFUSED area '9_lives.py'")
check("bad risk", save("f", area="misc", risk="maybe"), "REFUSED risk 'maybe'")
check("bucket that isn't there", (reset(admin=False), session(), run(T.__dict__.setdefault("_ns", kernel.fresh_namespace()), 'def f(x):\n    """x"""\n    return x'), save("f", area="misc", bucket="restricted"))[-1], "REFUSED there is no restricted/ folder")

# a function that runs fine in the session but can't load on its own: refused, the file left as it was
reset()
ns = session()
run(ns, '''
def ok(x):
    """Fine."""
    return x
''')
save("ok", area="fragile")
before = file("company", "fragile")
run(ns, '''
def needs_setup():
    raise RuntimeError("no config")
SETTING = needs_setup()  if False else 1
def guarded(x):
    """Uses a decorator that fails at load."""
    return x
''')
run(ns, '''
def boom(fn):
    raise RuntimeError("can't load")
''')
T._src["guarded"] = ["def", '@boom\ndef guarded(x):\n    """Uses a decorator that fails at load."""\n    return x']
check("broken save refused", save("guarded", area="fragile"), "REFUSED not saved: company/toolset/fragile.py wouldn't load")
assert file("company", "fragile") == before, "file changed by a refused save"

# ---------- one file per area ----------

reset()
ns = session()
run(ns, '''
def _headers(account):
    return {"account": account}
def search(q, account):
    """Find mails."""
    return ("search", q, _headers(account))
def send(to, account):
    """Send a mail."""
    return ("send", to, _headers(account))
''')
check("two tools in one area", save("search", area="gmail"), "Saved tool gmail.search")
check("…second keeps the first", T.save("send", area="gmail", risk="changes"), "Saved tool gmail.send (changes things)")
t = file("company", "gmail")
assert t.count("def _headers") == 1 and "def search" in t and "def send" in t, t
assert "# risk: changes\ndef send" in t, t
check("…both work fresh", fresh("gmail", "(search('x', 'a')[0], send('b', 'a')[0])"), "('search', 'send')")

run(ns, '''
def search(q, account, limit=10):
    """Find mails, at most limit."""
    return ("search2", q, limit, _headers(account))
''')
check("updating a tool replaces it in place", save("search", area="gmail"), "Saved tool gmail.search")
t = file("company", "gmail")
assert t.count("def search") == 1 and "search2" in t and t.index("def search") < t.index("def send"), t

run(ns, '''
def _headers(account):
    return {"who": account}
def reply(to, account):
    """Reply to a mail."""
    return ("reply", _headers(account))
''')
check("a different helper of the same name is refused", save("reply", area="gmail"), "REFUSED gmail.py already has a different _headers")
check("…unless replace=True", save("reply", area="gmail", replace=True), "Saved tool gmail.reply")
check("…and every tool there gets it", fresh("gmail", "send('b', 'a')[2]"), "{'who': 'a'}")

# a new session uses saved tools and builds on them in another area
ns = session()
run(ns, '''
from tools.gmail import send
def notify_all(people):
    """Mail everyone."""
    return [send(p, "office")[0] for p in people]
''')
check("new session builds on a saved tool", save("notify_all", area="outreach"), "Saved tool outreach.notify_all")
t = file("company", "outreach")
assert "from tools.gmail import send" in t and "def send" not in t, t
check("…runs fresh", fresh("outreach", "notify_all(['a', 'b'])"), "['send', 'send']")
run(ns, '''
from tools.gmail import search
def latest(q):
    """The latest mail about q."""
    return search(q, "office")
''')
check("saving into the area it imports from adds no self-import", save("latest", area="gmail"), "Saved tool gmail.latest")
assert "from tools.gmail" not in file("company", "gmail")

# listing and search
out = "\n".join(T.listing())
assert "tools.gmail.send(to, account): Send a mail. [changes things]" in out, out
assert "tools.gmail.search(q, account, limit=10): Find mails, at most limit. [only reads]" in out, out
assert "_headers" not in out
assert T.listing("mail every")[0] == "  tools.outreach.notify_all(people): Mail everyone. [only reads]", T.listing("mail every")
# a search that names the case still finds the general tool, best match first; short words don't count
assert T.listing("send acme a mail")[0].startswith("  tools.gmail.send("), T.listing("send acme a mail")
assert T.listing("in to a") == T.listing(), "short words alone match everything, like no words"
check("emplio.tools.<area> loads the area", repr(emplio.tools.gmail.send("x", "y")[0]), "'send'")

# buckets: a member saves to me/, own tools first; company tools never link to someone's own
reset(admin=False)
ns = session()
run(ns, 'def mine(x):\n    """Mine."""\n    return x')
check("a member's tool goes in me/", save("mine", area="own"), "in me/toolset/own.py")
check("a member can't keep company tools", save("mine", area="own", bucket="company"), "REFUSED company tools are the owner's")
check("a dashed area becomes underscores", save("mine", area="Website-Login"), "Saved tool website_login.mine")
reset()
ns = session()
run(ns, 'def helper(x):\n    """Helper."""\n    return x + 1')
T.save("helper", area="private_area", bucket="me")
run(ns, 'def shared(x):\n    """Shared."""\n    return helper(x) * 2')
check("company tool copies a me/ helper instead of linking it", save("shared", area="team"), "Saved tool team.shared")
assert "from tools.private_area" not in file("company", "team") and "def helper" in file("company", "team")

# drafts: a new Python session for the same chat can still save what the old one defined
reset()
T.start("chat1")
ns = session()
run(ns, 'def later(x):\n    """Saved after a restart."""\n    return x * 3')
T._src.clear()
T.start("chat1")
check("save after the session restarted", save("later", area="misc"), "Saved tool misc.later")
check("…works", fresh("misc", "later(2)"), "6")
T._drafts = None

# review fixes: labels, areas in two buckets, comments, inputs
reset()
ns = session()
run(ns, '''
# Pays the supplier
@staticmethod
def _deco(f): return f
''')
run(ns, '''
# Pays the supplier, in full
def pay(amount):
    """Pay a supplier."""
    return amount
''')
T.save("pay", area="money", risk="spends")
check("a comment above keeps the label on the def", repr([r for n, _, _, r in T._tools_in(os.path.join(WORK, "company", "toolset", "money.py"))]), "['spends']")
assert "# Pays the supplier, in full\n# risk: spends\ndef pay" in file("company", "money"), file("company", "money")
run(ns, '''
# Pays the supplier, in full
def pay(amount):
    """Pay a supplier."""
    return amount * 1
''')
check("saved again without a risk keeps spends", save("pay", area="money"), "Saved tool money.pay (spends money)")
check("emplio.tools.save without a risk keeps it too", str(T.Tools().save("pay", area="money").startswith("Saved tool money.pay (spends money)")), "True")
T.save("pay", area="money", bucket="company")
os.makedirs(os.path.join(WORK, "me", "toolset"), exist_ok=True)
check("an area can't be in two buckets", save("pay", area="money", bucket="me"), "REFUSED money is already an area in company/toolset/")
open(os.path.join(WORK, "company", "toolset", "money.py"), "a").write("\n\n# --- reading ---\n\n\n# TODO: refunds\n")
run(ns, '''
def balance():
    """The balance."""
    return 0
''')
T.save("balance", area="money")
check("loose comments survive a save", str("# --- reading ---" in file("company", "money") and "# TODO: refunds" in file("company", "money")), "True")
run(ns, '''
import datetime
def when():
    """A date."""
    return datetime.date(2026, 1, 1)
''')

# a tool that changes things asks first (emplio tools allow), against a stand-in emplio command
reset()
ns = session()
run(ns, '''
RAN = []
def note(x):
    """Reads."""
    return x
def grant(email, months=1):
    """Changes."""
    RAN.append(email)
    return note(f"granted {email} {months}")
''')
T.save("note", area="acct")
T.save("grant", area="acct", risk="changes")
fake = tempfile.mkdtemp()
with open(os.path.join(fake, "emplio"), "w") as f:
    f.write("#!/bin/sh\necho \"$@\" >> " + os.path.join(fake, "asked") + "\ncat " + os.path.join(fake, "answer") + "\n")
os.chmod(os.path.join(fake, "emplio"), 0o755)


def call(answer, code):
    open(os.path.join(fake, "answer"), "w").write(answer)
    prog = f"import sys; sys.path.insert(0, {os.path.join(HERE, 'py')!r}); import emplio\ntry:\n    {code}\nexcept emplio.EmplioError as e:\n    print('REFUSED', e)"
    env = {**os.environ, "PATH": fake + os.pathsep + os.environ["PATH"], "EZ_KEY": "k1"}
    r = subprocess.run([sys.executable, "-c", prog], capture_output=True, text=True, env=env, timeout=60)
    return (r.stdout + r.stderr).strip()


check("a changing tool runs once allowed", call("allowed", "from tools.acct import grant, RAN; print(grant('a@b.c', months=2), RAN)"), "granted a@b.c 2 ['a@b.c']")
asked = open(os.path.join(fake, "asked")).read()
assert asked.startswith("tools allow acct.grant ") and '"kwargs": {"months": 2}' in asked and '"risk": "changes"' in asked, asked
check("…and doesn't run when refused", call("error: Ashish said no", "from tools.acct import grant, RAN; grant('a@b.c'); print(RAN)"), "REFUSED error: Ashish said no")
check("a reading tool never asks", (os.remove(os.path.join(fake, "asked")), call("error: no", "from tools.acct import note; print(note('x'))"))[1], "x")
assert not os.path.exists(os.path.join(fake, "asked"))
check("a date input can't go with the ask", call("allowed", "import datetime\n    from tools.acct import grant; grant(datetime.date(2026, 1, 1))"), "REFUSED tools.acct.grant needs the person's OK")
open(os.path.join(WORK, "company", "toolset", "acct.py"), "a").write('\n\n# risk: changes\ndef grant_all(emails):\n    """All."""\n    import emplio\n    return [str(x) for x in emplio.map(grant, emails)]\n')
if os.path.exists(os.path.join(fake, "asked")):
    os.remove(os.path.join(fake, "asked"))
out = call("allowed", "from tools.acct import grant_all; print(grant_all(['a', 'b', 'c']))")
check("emplio.map inside an allowed tool asks once, not per item", str(open(os.path.join(fake, "asked")).read().count("tools allow")) + " " + out[-30:], "1 " + out[-30:])
check("Emplio's own run once allowed doesn't ask again", call("error: no", "import os; os.environ['EMPLIO_TOOL_OK'] = 'acct.grant'\n    from tools.acct import grant; print(grant('z@z.z'))"), "granted z@z.z 1")

# a person's own computer: /work is a folder in their home, and a path Emplio answers with must open there too
os.makedirs(os.path.join(WORK, "tmp", "apps", "files"), exist_ok=True)
open(os.path.join(WORK, "tmp", "apps", "files", "shot.png"), "w").write("png")
check("a path in Emplio's answer is this computer's", call('{"file": "/work/tmp/apps/files/shot.png"}', "p = emplio.apps.run('x')['file']; print(open(p).read(), p == emplio.W + '/tmp/apps/files/shot.png')"), "png True")
check("…and a shell command built from one runs", call("/work/tmp/apps/files/shot.png", "print(emplio.sh('cat ' + emplio.apps.run('x')))"), "png")
check("…a path built at run time too", call("x", "print(emplio.sh('cat ' + '/wo' + 'rk/tmp/apps/files/shot.png'))"), "png")
check("…but not /workspace or ~/work", emplio._local("/workspace ~/work a/work"), "/workspace ~/work a/work")

# what a tool gives back is said where it's listed, so the next job needn't read its code
T.NEED_RETURNS = True
ns = session()
run(ns, """
def thread_msgs(thread_id):
    \"\"\"Messages in a mail thread.\"\"\"
    return [{"from": "a", "text": thread_id}]
def thread_msgs2(thread_id):
    \"\"\"Messages in a mail thread.

    Returns a list of dicts with from and text, oldest first.\"\"\"
    return [{"from": "a", "text": thread_id}]
def mark_read(thread_id) -> bool:
    \"\"\"Mark a thread read.\"\"\"
    return True
def archive(thread_id):
    \"\"\"Archive a thread.\"\"\"
    print(thread_id)
""")
check("a tool that returns something must say what", save("thread_msgs", area="mail")[:60], "REFUSED say in thread_msgs's docstring what it returns (\"Re")
check("…said in the docstring", save("thread_msgs2", area="mail"), "Saved tool mail.thread_msgs2 (only reads) in company/toolset/mail.py. Use it: from tools.mail import thread_msgs2")
check("…or as -> annotation", save("mark_read", area="mail", risk="changes")[:31], "Saved tool mail.mark_read (chan")
check("…and one returning nothing needn't", save("archive", area="mail", risk="changes")[:28], "Saved tool mail.archive (cha")
check("search shows what it returns", T.listing("thread")[0], "  tools.mail.thread_msgs2(thread_id): Messages in a mail thread. Returns a list of dicts with from and text, oldest first. [only reads]")
import io, contextlib
out = io.StringIO()
with contextlib.redirect_stdout(out):
    T.Tools().show("mail.mark_read")
check("show: the tool in full without its code", out.getvalue().splitlines()[0], "tools.mail.mark_read(thread_id) -> bool  [changes things, company/toolset/mail.py]")

check("a string answer comes back unquoted (#243)", repr([emplio._parse(x) for x in ('""', '"abc"', '"a" b')]), "['', 'abc', '\"a\" b']")

print(f"\n{'all passed' if not FAILED else f'{len(FAILED)} failed'}")
for f in FAILED:
    print("  ", f)
shutil.rmtree(WORK, ignore_errors=True)
sys.exit(1 if FAILED else 0)
