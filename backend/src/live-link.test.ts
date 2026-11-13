import { expect, test } from "bun:test";
import { liveUrlOf } from "./browser-host";

process.env.ENCRYPTION_KEY ??= "test-key";

// the hosted server sets only WEBHOOK_URL: the live view link must still be its public address, not localhost
test("live view link uses the server's public address", () => {
  const was = { p: process.env.PUBLIC_API_URL, w: process.env.WEBHOOK_URL };
  delete process.env.PUBLIC_API_URL;
  process.env.WEBHOOK_URL = "https://api.example.com";
  try {
    expect(liveUrlOf("c1", new Date(Date.now() + 60_000).toISOString(), "device-live")).toStartWith("https://api.example.com/device-live/c1?t=");
  } finally {
    if (was.p === undefined) delete process.env.PUBLIC_API_URL; else process.env.PUBLIC_API_URL = was.p;
    if (was.w === undefined) delete process.env.WEBHOOK_URL; else process.env.WEBHOOK_URL = was.w;
  }
});
