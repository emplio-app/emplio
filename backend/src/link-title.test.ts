import { expect, test } from "bun:test";
import { isPrivate, linkTitle, titleOf } from "./link-title";

test("private addresses are refused", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe"])
    expect(isPrivate(ip)).toBe(true);
  for (const ip of ["8.8.8.8", "151.101.1.140", "2606:4700::1111"]) expect(isPrivate(ip)).toBe(false);
});

test("title from <title>, else og:title, entities decoded", () => {
  expect(titleOf(`<meta property="og:title" content="Generic"><title>Real &amp; page</title>`)).toBe("Real & page");
  expect(titleOf(`<meta property="og:title" content="Hi &amp; bye"><title> </title>`)).toBe("Hi & bye");
  expect(titleOf(`<meta content='Flip' property='og:title'>`)).toBe("Flip");
  expect(titleOf(`<title>\n  A   page &#39;s </title>`)).toBe("A page 's");
  expect(titleOf(`<p>none</p>`)).toBeNull();
});

test("never fetches inside the network", async () => {
  expect(await linkTitle("http://127.0.0.1:4000/health")).toBeNull();
  expect(await linkTitle("http://localhost/")).toBeNull();
  expect(await linkTitle("file:///etc/passwd")).toBeNull();
  expect(await linkTitle("http://[::ffff:169.254.169.254]/")).toBeNull();
});
