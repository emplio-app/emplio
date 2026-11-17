import { expect, test } from "bun:test";
import { areaOf, labelled, pointed } from "../scripts/migrate-toolset";

test("old function files become tool areas with risk labels", () => {
  expect(areaOf("website-login")).toBe("website_login");
  expect(areaOf("2fa")).toBe("t_2fa");
  expect(areaOf("import")).toBe("import_tools");
  const py = `import emplio\n\n\ndef _q(x):\n    return x\n\n\n# Finds them\n@cache\ndef find(q):\n    """Find."""\n    return emplio.apps.run("gmail.search", {"q": q})\n\n\ndef send(to):\n    emplio.browser.click("@e1")\n\n\n# risk: spends\ndef pay(x):\n    pass\n`;
  const out = labelled(py);
  expect(out).toContain("# Finds them\n# risk: reads\n@cache\ndef find(q):");
  expect(out).toContain("# risk: changes\ndef send(to):");
  expect(out).toContain("# risk: spends\ndef pay(x):");
  expect(out).not.toContain("# risk: reads\ndef _q");
  expect(out.match(/# risk:/g)!.length).toBe(3);
});

test("the old way's names point at the tools", () => {
  const area = (kind: string, name: string) => (name === "zoho-invoices" ? "zoho_invoices" : name === "gst" ? "gst" : undefined);
  expect(pointed(`inv = emplio.skill("zoho-invoices")\ng = emplio.lib('gst')\nx = emplio.skill("other")`, area)).toBe(`inv = emplio.tools.zoho_invoices\ng = emplio.tools.gst\nx = emplio.skill("other")`);
  expect(pointed("see skills/zoho-invoices/functions.py and lib/gst.py", area)).toBe("see toolset/zoho_invoices.py and toolset/gst.py");
  expect(pointed(`d = os.path.dirname(os.path.abspath(__file__))\np = Path(__file__).parent / "t.xlsx"`, area, "/work/company/skills/s")).toBe(`d = "/work/company/skills/s"\np = Path("/work/company/skills/s") / "t.xlsx"`);
});
