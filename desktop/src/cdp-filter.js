// What someone driving the app's embedded browser (through the server) may see and do of it.
//
// The app's DevTools port belongs to the whole app, so next to the agent's tabs it also lists Emplio's own window,
// signed in as the person. The agent (and the server) must never see or attach to that, and Electron can't open a tab from
// DevTools (Target.createTarget is "Not supported"), so the app opens one itself. Both are done here, one filter per
// connection, in plain functions a test can run.
//
//   fromClient(text) -> { forward?: string, reply?: string, later?: Promise<string> }
//     forward: send this on to the browser; reply: answer the client right away; later: an answer once the app has acted
//   fromChrome(text) -> string | null   (null: the client never hears of it)
const error = (id, message) => JSON.stringify({ id, error: { code: -32602, message } });
const ok = (id, result = {}) => JSON.stringify({ id, result });
// an answer to a command sent to a page's session carries the session
const answer = (m, result) => JSON.stringify({ id: m.id, result, ...(m.sessionId ? { sessionId: m.sessionId } : {}) });

// DevTools commands that name one target (page)
const NAMES_A_TARGET = new Set(["Target.attachToTarget", "Target.activateTarget", "Target.exposeDevToolsProtocol", "Target.getTargetInfo"]);
// ...and those that would reach past the agent's own browser
const REFUSED = new Set(["Target.createBrowserContext", "Target.disposeBrowserContext", "Target.sendMessageToTarget", "Target.setRemoteLocations", "Browser.crash", "Browser.crashGpuProcess"]);

export function createFilter({ allowed, createTarget, closeTarget, activate, emulate }) {
  const listing = new Set(); // ids of Target.getTargets asked and not yet answered

  const mine = (info) => info?.type === "browser" || allowed().has(info?.targetId);

  return {
    fromClient(text) {
      let m;
      try {
        m = JSON.parse(text);
      } catch {
        return { forward: text };
      }
      if (typeof m.method !== "string") return { forward: text };
      const { id, method, params = {} } = m;
      if (REFUSED.has(method)) return { reply: error(id, "not supported here") };
      if (method === "Browser.close") return { reply: ok(id) };
      // the page size is the app's to keep (it scales the page to the panel), so a size asked for goes to it
      if (method === "Emulation.setDeviceMetricsOverride" && emulate && params.width > 0 && params.height > 0) {
        emulate({ width: params.width, height: params.height, mobile: !!params.mobile });
        return { reply: answer(m, {}) };
      }
      if (method === "Emulation.clearDeviceMetricsOverride" && emulate) {
        emulate(null);
        return { reply: answer(m, {}) };
      }
      if (method === "Target.createTarget") return { later: createTarget(params).then((targetId) => ok(id, { targetId })).catch((e) => error(id, String(e?.message ?? e))) };
      if (method === "Target.closeTarget") {
        if (!allowed().has(params.targetId)) return { reply: error(id, "No target with given id found") };
        return { later: closeTarget(params.targetId).then(() => ok(id, { success: true })).catch((e) => error(id, String(e?.message ?? e))) };
      }
      if (NAMES_A_TARGET.has(method) && params.targetId !== undefined && !allowed().has(params.targetId)) return { reply: error(id, "No target with given id found") };
      if (method === "Target.activateTarget") activate?.(params.targetId);
      if (method === "Target.getTargets") listing.add(id);
      return { forward: text };
    },

    fromChrome(text) {
      let m;
      try {
        m = JSON.parse(text);
      } catch {
        return text;
      }
      if (typeof m.id === "number" && listing.delete(m.id) && m.result?.targetInfos) {
        return JSON.stringify({ ...m, result: { ...m.result, targetInfos: m.result.targetInfos.filter(mine) } });
      }
      switch (m.method) {
        case "Target.targetCreated":
        case "Target.targetInfoChanged":
        case "Target.attachedToTarget":
          return mine(m.params?.targetInfo) ? text : null;
        case "Target.targetDestroyed":
        case "Target.targetCrashed":
          return allowed().has(m.params?.targetId) ? text : null;
        default:
          return text;
      }
    },
  };
}

// Which pages and sockets of the app's DevTools port may be read: the browser's own socket and the agent's pages only.
export function allowedPath(path, ids) {
  const page = /^\/devtools\/page\/([^/?]+)/.exec(path);
  if (page) return ids.has(page[1]);
  return /^\/devtools\/browser\/[^/?]+$/.test(path);
}

// /json/list with only the agent's pages; /json/version as is; the rest (new, activate, close) refused
export function listPage(path, body, ids) {
  if (/^\/json\/version\/?$/.test(path)) return body;
  if (/^\/json(\/list)?\/?$/.test(path)) {
    try {
      return JSON.stringify(JSON.parse(body).filter((t) => ids.has(t.id)), null, 2);
    } catch {
      return "[]";
    }
  }
  return null;
}
