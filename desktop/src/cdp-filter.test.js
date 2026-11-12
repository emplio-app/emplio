import { expect, test } from "bun:test";
import { allowedPath, createFilter, listPage } from "./cdp-filter.js";

const mine = new Set(["A1"]);
const make = (extra = {}) => createFilter({ allowed: () => mine, createTarget: async () => "NEW", closeTarget: async () => {}, activate: () => {}, ...extra });
const msg = (o) => JSON.stringify(o);

test("the app's own window can't be attached to, activated or closed", async () => {
  const f = make();
  for (const method of ["Target.attachToTarget", "Target.activateTarget", "Target.closeTarget", "Target.getTargetInfo"]) {
    const r = f.fromClient(msg({ id: 1, method, params: { targetId: "APPWINDOW" } }));
    const answer = JSON.parse(r.reply ?? (await r.later));
    expect(answer.error.message).toContain("No target");
    expect(r.forward).toBeUndefined();
  }
  expect(make().fromClient(msg({ id: 2, method: "Target.attachToTarget", params: { targetId: "A1", flatten: true } })).forward).toBeTruthy();
});

test("a tab is opened by the app, since Electron can't", async () => {
  const r = make().fromClient(msg({ id: 3, method: "Target.createTarget", params: { url: "https://example.com" } }));
  expect(r.forward).toBeUndefined();
  expect(JSON.parse(await r.later)).toEqual({ id: 3, result: { targetId: "NEW" } });
});

test("the target list and its events only show the agent's own tabs", () => {
  const f = make();
  f.fromClient(msg({ id: 4, method: "Target.getTargets" }));
  const out = JSON.parse(f.fromChrome(msg({ id: 4, result: { targetInfos: [{ targetId: "A1", type: "page" }, { targetId: "APPWINDOW", type: "page" }, { targetId: "B", type: "browser" }] } })));
  expect(out.result.targetInfos.map((t) => t.targetId)).toEqual(["A1", "B"]);
  expect(f.fromChrome(msg({ method: "Target.targetCreated", params: { targetInfo: { targetId: "APPWINDOW", type: "page" } } }))).toBeNull();
  expect(f.fromChrome(msg({ method: "Target.attachedToTarget", params: { sessionId: "s", targetInfo: { targetId: "APPWINDOW", type: "page" } } }))).toBeNull();
  expect(f.fromChrome(msg({ method: "Target.targetInfoChanged", params: { targetInfo: { targetId: "A1", type: "page" } } }))).not.toBeNull();
  expect(f.fromChrome(msg({ method: "Target.targetDestroyed", params: { targetId: "APPWINDOW" } }))).toBeNull();
});

test("nothing can close the browser or make a second one", () => {
  const f = make();
  expect(JSON.parse(f.fromClient(msg({ id: 5, method: "Browser.close" })).reply)).toEqual({ id: 5, result: {} });
  expect(JSON.parse(f.fromClient(msg({ id: 6, method: "Target.createBrowserContext" })).reply).error).toBeTruthy();
});

test("only the browser's socket and the agent's pages can be opened, and listed", () => {
  expect(allowedPath("/devtools/browser/abc-123", mine)).toBe(true);
  expect(allowedPath("/devtools/page/A1", mine)).toBe(true);
  expect(allowedPath("/devtools/page/APPWINDOW", mine)).toBe(false);
  expect(allowedPath("/devtools/inspector.html", mine)).toBe(false);
  const body = JSON.stringify([{ id: "A1" }, { id: "APPWINDOW" }]);
  expect(JSON.parse(listPage("/json/list", body, mine)).map((t) => t.id)).toEqual(["A1"]);
  expect(listPage("/json/new?https://x", body, mine)).toBeNull();
  expect(listPage("/json/version", "{}", mine)).toBe("{}");
});

test("a page size asked for goes to the app, which keeps the page that size", () => {
  const seen = [];
  const f = make({ emulate: (size) => seen.push(size) });
  const r = f.fromClient(msg({ id: 7, sessionId: "S1", method: "Emulation.setDeviceMetricsOverride", params: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true } }));
  expect(JSON.parse(r.reply)).toEqual({ id: 7, result: {}, sessionId: "S1" });
  expect(r.forward).toBeUndefined();
  f.fromClient(msg({ id: 8, method: "Emulation.clearDeviceMetricsOverride" }));
  expect(seen).toEqual([{ width: 390, height: 844, mobile: true }, null]);
});
