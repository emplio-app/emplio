import { expect, test } from "bun:test";
import { noteEmail } from ".";

test("a check-in by email: the note as text and HTML, with a link back to the chat", () => {
  const link = "https://emplio.app/chat/123";
  const [text, { html }] = noteEmail('**Morning brief**\n\n- Pay <rent> [bill](https://x.com/a"onclick=1)', link);
  expect(text).toBe('**Morning brief**\n\n- Pay <rent> [bill](https://x.com/a"onclick=1)\n\nAnswer in Emplio: https://emplio.app/chat/123');
  expect(html).toContain("<b>Morning brief</b><br><br>• Pay &lt;rent&gt; ");
  // a quote in the note can't break out of a link
  expect(html).toContain('<a href="https://x.com/a&quot;onclick=1">bill</a>');
  expect(html).toContain(`<a href="${link}"`);
});
