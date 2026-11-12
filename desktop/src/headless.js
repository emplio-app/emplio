// The same computer-side as the app, with no window: for trying it out, for a Mac that only runs it in the background,
// and for tests. EMPLIO_API=http://localhost:4000 EMPLIO_TOKEN=<token from POST /devices> node src/headless.js
import { homedir } from "node:os";
import { join } from "node:path";
import { Boxes } from "./box.js";
import { Browsers } from "./chrome.js";
import { Link } from "./link.js";

const api = process.env.EMPLIO_API;
const token = process.env.EMPLIO_TOKEN;
if (!api || !token) throw new Error("set EMPLIO_API and EMPLIO_TOKEN");

const boxes = new Boxes(process.env.EMPLIO_FOLDER ?? join(homedir(), "Emplio"));
const browsers = new Browsers();
const link = new Link({
  onState: (s) => console.log("state:", s),
  handlers: {
    async request(method, p, id) {
      console.log("<-", method, JSON.stringify(p).slice(0, 160));
      switch (method) {
        case "run":
          return boxes.run(id, p);
        case "write":
          return boxes.write(p);
        case "read":
          return boxes.read(p);
        case "remove":
          return boxes.remove(p);
        case "browser.start": {
          const { root, work } = await boxes.ensure(p);
          return browsers.start({ root, work, chat: p.chat });
        }
        case "browser.list":
          return browsers.list(p.chat);
        case "browser.stop":
          return void browsers.stop(p.key);
        case "cdp.http":
          return browsers.http(p.key, p.path);
        default:
          throw new Error(`can't do ${method}`);
      }
    },
    note(method, p) {
      if (method === "cancel") boxes.cancel(p.id);
      else if (method === "cdp.open")
        browsers.connect({ id: p.key, conn: p.conn, path: p.path }, { data: (conn, data) => link.send({ ev: "cdp.data", conn, data }), closed: (conn) => link.send({ ev: "cdp.closed", conn }) });
      else if (method === "cdp.send") browsers.send(p.conn, p.data);
      else if (method === "cdp.close") browsers.close(p.conn);
    },
  },
});
process.on("SIGINT", () => {
  boxes.stopAll();
  browsers.stopAll();
  process.exit(0);
});
link.start(api, token);
