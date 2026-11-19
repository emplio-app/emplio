// A made-up shop's back office for the browser benchmark: sign-in, orders over several pages, a cookie banner over
// the pager, a confirm box that wants a word typed, an icon-only star with no name, and settings tabs. Big menus and
// footers on purpose, so a page's list of buttons and links is as long as a real admin's. Everything it changed is at
// /__state, so a run is marked by what happened, not by what the model says happened.
const NAMES = ["Patel", "Sharma", "Iyer", "Khan", "Das", "Mehta", "Rao", "Gupta", "Nair", "Joshi"];
const STATUSES = ["Pending", "Packed", "Shipped", "Delivered"];

type Order = { id: number; customer: string; total: number; status: string; note: string; starred: boolean; refunded: boolean };
export type State = { signedIn: boolean; orders: Order[]; digest: boolean; sms: boolean; saves: number };

export function fresh(): State {
  const orders: Order[] = [];
  for (let i = 0; i < 64; i++) {
    const id = 1001 + i;
    orders.push({ id, customer: `${NAMES[(i * 7) % NAMES.length]} ${String.fromCharCode(65 + (i % 26))}.`, total: 450 + ((i * 337) % 4100), status: STATUSES[i % 4]!, note: "", starred: false, refunded: false });
  }
  return { signedIn: false, orders, digest: true, sms: false, saves: 0 };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const MENU = ["Dashboard", "Orders", "Products", "Collections", "Inventory", "Transfers", "Gift cards", "Customers", "Segments", "Discounts", "Campaigns", "Automations", "Content", "Blog posts", "Pages", "Navigation", "Files", "Analytics", "Reports", "Live view", "Finances", "Payouts", "Billing", "Online store", "Themes", "Point of sale", "Apps", "Sales channels", "Markets", "Settings"];
const FOOT = ["Help centre", "Community", "Changelog", "Status", "API docs", "Partners", "Careers", "Privacy", "Terms", "Accessibility", "Cookie settings", "Contact us"];

function page(title: string, body: string, banner: boolean) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title} · Kaveri Admin</title><style>
body{font-family:system-ui;margin:0;display:grid;grid-template-columns:200px 1fr;min-height:100vh}
nav{background:#1f2937;padding:8px}nav a{display:block;color:#ddd;padding:3px 6px;font-size:13px;text-decoration:none}
main{padding:20px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}
.pager{margin-top:16px;display:flex;gap:8px}
#cookie{position:fixed;left:0;right:0;bottom:0;height:140px;background:#111;color:#fff;padding:16px;z-index:10}
#modal{display:none;position:fixed;inset:0;background:#0008;z-index:20}#modal>div{background:#fff;margin:15vh auto;width:360px;padding:20px}
.star{display:inline-block;width:28px;height:28px;cursor:pointer}
footer{grid-column:1/3;padding:12px;background:#f3f4f6}footer a{margin-right:10px;font-size:12px}
.toast{background:#dcfce7;padding:8px;margin:8px 0}
</style></head><body>
<nav>${MENU.map((m) => `<a href="${m === "Orders" ? "/orders" : m === "Settings" ? "/settings" : "#"}">${m}</a>`).join("")}</nav>
<main>${body}</main>
<footer>${FOOT.map((f) => `<a href="#">${f}</a>`).join("")}</footer>
${banner ? `<div id="cookie"><p>We use cookies to improve your experience. Read our cookie policy to learn more about how we use them and your choices.</p><button onclick="document.cookie='ok=1;path=/';this.parentNode.remove()">Accept all</button> <button onclick="document.cookie='ok=1;path=/';this.parentNode.remove()">Reject</button></div>` : ""}
</body></html>`;
}

const html = (s: string) => new Response(s, { headers: { "Content-Type": "text/html; charset=utf-8" } });
const go = (to: string) => new Response(null, { status: 303, headers: { Location: to } });

export function serve(state: { s: State }) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const s = state.s;
      const banner = !/(^|;\s*)ok=1/.test(req.headers.get("cookie") ?? "");
      // a POST with no form (the star) has nothing to read
      const form = req.method === "POST" && /form/.test(req.headers.get("content-type") ?? "") ? Object.fromEntries((await req.formData()).entries()) as Record<string, string> : {};
      if (url.pathname === "/__state") return Response.json(s);
      if (url.pathname === "/login") {
        if (req.method === "POST") {
          if (form.email === "meera@kaveri.example" && form.password === "linen-2026") {
            s.signedIn = true;
            return go("/orders");
          }
          return html(page("Sign in", `<h1>Sign in</h1><p class="toast" style="background:#fee2e2">Wrong email or password.</p>${loginForm()}`, banner));
        }
        return html(page("Sign in", `<h1>Sign in</h1>${loginForm()}`, banner));
      }
      if (!s.signedIn) return go("/login");
      if (url.pathname === "/" || url.pathname === "/orders") {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const p = Math.max(1, Number(url.searchParams.get("page") ?? 1));
        const all = s.orders.filter((o) => !q || o.customer.toLowerCase().includes(q) || String(o.id).includes(q));
        const rows = all.slice((p - 1) * 20, p * 20);
        const pages = Math.max(1, Math.ceil(all.length / 20));
        return html(page("Orders", `<h1>Orders</h1>
<form method="get" action="/orders" role="search"><input name="q" placeholder="Search orders" value="${esc(q)}"> <button>Search</button></form>
<table><thead><tr><th>Order</th><th>Customer</th><th>Total</th><th>Status</th><th></th></tr></thead><tbody>
${rows.map((o) => `<tr><td><a href="/orders/${o.id}">#${o.id}</a></td><td>${esc(o.customer)}</td><td>₹${o.total}</td><td>${o.status}${o.refunded ? " (refunded)" : ""}</td><td>${o.starred ? "★" : ""}</td></tr>`).join("")}
</tbody></table>
<div class="pager"><span>Page ${p} of ${pages}</span>${p > 1 ? `<a href="/orders?page=${p - 1}&q=${encodeURIComponent(q)}">Previous</a>` : ""}${p < pages ? `<button onclick="location='/orders?page=${p + 1}&q=${encodeURIComponent(q)}'">Next page</button>` : ""}</div>`, banner));
      }
      const m = /^\/orders\/(\d+)(\/(save|refund|star))?$/.exec(url.pathname);
      if (m) {
        const o = s.orders.find((x) => x.id === Number(m[1]));
        if (!o) return html(page("Not found", "<h1>No such order</h1>", banner));
        if (req.method === "POST" && m[3] === "save") {
          o.status = form.status ?? o.status;
          o.note = form.note ?? o.note;
          s.saves++;
          return go(`/orders/${o.id}?saved=1`);
        }
        if (req.method === "POST" && m[3] === "refund") {
          if (form.confirm === "REFUND") o.refunded = true;
          return go(`/orders/${o.id}${form.confirm === "REFUND" ? "?refunded=1" : ""}`);
        }
        if (req.method === "POST" && m[3] === "star") {
          o.starred = !o.starred;
          return new Response("ok");
        }
        return html(page(`Order #${o.id}`, `<h1>Order #${o.id}</h1>
${url.searchParams.get("saved") ? `<p class="toast">Order saved.</p>` : ""}${url.searchParams.get("refunded") ? `<p class="toast">Refund issued.</p>` : ""}
<p>${esc(o.customer)} · ₹${o.total} · ${o.status}${o.refunded ? " · refunded" : ""}
<span class="star" onclick="fetch('/orders/${o.id}/star',{method:'POST'}).then(()=>location.reload())"><svg viewBox="0 0 24 24" width="28" height="28"><path d="M12 2l3 7h7l-5.5 4.5 2 7.5-6.5-4.5-6.5 4.5 2-7.5L2 9h7z" fill="${o.starred ? "#f59e0b" : "#d1d5db"}"/></svg></span></p>
<form method="post" action="/orders/${o.id}/save">
<label>Status <select name="status">${STATUSES.map((x) => `<option${x === o.status ? " selected" : ""}>${x}</option>`).join("")}</select></label><br><br>
<label>Internal note <textarea name="note">${esc(o.note)}</textarea></label><br><br>
<button>Save order</button></form>
<p><button onclick="document.getElementById('modal').style.display='block'">Refund…</button></p>
<div id="modal"><div><h2>Refund this order?</h2><p>Type REFUND to confirm.</p><form method="post" action="/orders/${o.id}/refund"><input name="confirm" aria-label="Confirmation"> <button>Issue refund</button> <button type="button" onclick="document.getElementById('modal').style.display='none'">Cancel</button></form></div></div>`, banner));
      }
      if (url.pathname === "/settings") {
        if (req.method === "POST") {
          s.digest = form.digest === "on";
          s.sms = form.sms === "on";
          s.saves++;
          return go("/settings?tab=notifications&saved=1");
        }
        const tab = url.searchParams.get("tab") ?? "profile";
        return html(page("Settings", `<h1>Settings</h1>
<div role="tablist"><a role="tab" href="/settings?tab=profile" aria-selected="${tab === "profile"}">Profile</a> · <a role="tab" href="/settings?tab=notifications" aria-selected="${tab === "notifications"}">Notifications</a></div>
${url.searchParams.get("saved") ? `<p class="toast">Settings saved.</p>` : ""}
${tab === "profile" ? `<p>Meera · owner · meera@kaveri.example</p>` : `<form method="post" action="/settings">
<label><input type="checkbox" name="digest"${s.digest ? " checked" : ""}> Weekly digest email</label><br>
<label><input type="checkbox" name="sms"${s.sms ? " checked" : ""}> SMS on every order</label><br><br>
<button>Save settings</button></form>`}`, banner));
      }
      return html(page("Not found", "<h1>Not found</h1>", banner));
    },
  });
}

const loginForm = () => `<form method="post" action="/login"><label>Email <input name="email" type="email"></label><br><br><label>Password <input name="password" type="password"></label><br><br><button>Sign in</button></form>`;
