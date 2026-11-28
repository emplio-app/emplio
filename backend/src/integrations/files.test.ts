import { expect, test } from "bun:test";
import { attachFiles } from "./index";
import { AppFile } from "./types";

test("a phone's IMG_1234.JPG goes as a photo, not a document", async () => {
  const f = (await attachFiles({ file: "/work/in/IMG_1234.JPG" }, async () => new Uint8Array([1]))) as AppFile;
  expect(f.mimetype).toBe("image/jpeg");
  expect(f.name).toBe("IMG_1234.JPG");
});
