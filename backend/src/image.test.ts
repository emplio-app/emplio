import { expect, test } from "bun:test";
import { imageCommand } from "./image";

test("sends the prompt, the start picture and the shape; saves under the real type's extension; charges the cost", async () => {
  let sent: any;
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return Response.json({ choices: [{ message: { content: "", images: [{ image_url: { url: `data:image/jpeg;base64,${btoa("JPG")}` } }] } }], usage: { cost: 0.04 } });
  }) as typeof fetch;
  const files = new Map<string, Uint8Array>([["/work/in/logo.png", new Uint8Array([1, 2])]]);
  const spent: number[] = [];
  try {
    const reply = await imageCommand(
      { imageModel: "google/gemini-nano-banana-2.1", openrouterKey: "sk-or-x" },
      ["a", "blue", "logo", "--from", "/work/in/logo.png", "--ratio", "16:9", "--out", "/work/out/logo.png"],
      { read: async (p) => files.get(p)!, write: async (p, b) => void files.set(p, b), spend: (usd) => spent.push(usd) },
    );
    expect(reply).toBe("Saved /work/out/logo.jpg");
    expect(new TextDecoder().decode(files.get("/work/out/logo.jpg"))).toBe("JPG");
    expect(sent.model).toBe("google/gemini-nano-banana-2.1");
    expect(sent.image_config).toEqual({ aspect_ratio: "16:9" });
    expect(sent.messages[0].content[0].text).toBe("a blue logo");
    expect(sent.messages[0].content[1].image_url.url).toStartWith("data:image/png;base64,");
    expect(spent).toEqual([0.04]);
  } finally {
    globalThis.fetch = real;
  }
});

test("refuses a bad shape and a missing start picture before calling anyone", async () => {
  const io = { read: async () => Promise.reject(new Error("no")), write: async () => {}, spend: () => {} };
  const s = { imageModel: "google/gemini-nano-banana-2.1", openrouterKey: "sk-or-x" };
  expect(await imageCommand(s, ["x", "--ratio", "7:3"], io)).toStartWith("error: --ratio");
  expect(await imageCommand(s, ["x", "--from", "/work/a.png"], io)).toBe("error: /work/a.png: no such file");
  expect(await imageCommand(s, [], io)).toStartWith("usage:");
});

test("a misspelt option is refused, not slipped into the description; from_ as a list sends each", async () => {
  const io = { read: async () => new Uint8Array([1]), write: async () => {}, spend: () => {} };
  const s = { imageModel: "google/gemini-nano-banana-2.1", openrouterKey: "sk-or-x" };
  expect(await imageCommand(s, ["a", "post", "--frm", "/work/out/logo.png"], io)).toStartWith("error: no option --frm. A starting picture is --from");
  let sent: any;
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init: RequestInit) => ((sent = JSON.parse(String(init.body))), Response.json({ choices: [{ message: { images: [{ image_url: { url: "data:image/png;base64,AA==" } }] } }] }))) as typeof fetch;
  try {
    await imageCommand(s, ["a", "post", "--from", '["/work/a.png","/work/b.jpg"]'], io);
    expect(sent.messages[0].content.length).toBe(3);
  } finally {
    globalThis.fetch = real;
  }
});
