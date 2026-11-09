// Zoho Books and Zoho Invoice publish one zip of per-area OpenAPI files. This downloads and unpacks one, for the generator.
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../openapi-actions";
import { namer } from "./composio-names";

// Zoho's specs give defaults for fields like tax_treatment; left in, every write would quietly send them
export const noDefaults = (text: string) => text.replace(/^\s*default:\s+(?![>|]).*\n/gm, "");

export async function zohoZip(product: "books" | "invoice") {
  const dir = await mkdtemp(join(tmpdir(), `zoho-${product}-`));
  const zip = join(dir, "spec.zip");
  await Bun.write(zip, await (await fetch(`https://www.zoho.com/${product}/api/v3/openapi-all.zip`)).arrayBuffer());
  await Bun.$`unzip -qo ${zip} -d ${dir}`;
  const files = (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => join(dir, f));
  // every list that sorts can sort either way (Zoho's own answers show it), but the spec only lists sort_column
  for (const f of files)
    await Bun.write(f, noDefaults(await Bun.file(f).text()).replace(/^( *)- name: sort_column\n(?:\1  .*\n)+/gm, (block, i: string) =>
      `${block}${i}- name: sort_order\n${i}  in: query\n${i}  required: false\n${i}  description: 'A for ascending, D for descending'\n${i}  schema:\n${i}    type: string\n${i}    enum: [A, D]\n`));
  return files;
}

// the org id isn't part of a call's meaning: index.ts makes it optional and fills it in
export const BOOKISH = {
  params: { organization_id: "Which organisation to act on (its organization_id). Leave out when the login has just one; Emplio fills it in." },
};

// namer, except that an operation whose own id is already another's name gets its path added, so the id stays one of a kind
export function zohoNamer(theirs: string[]): NonNullable<AppConfig["name"]> {
  const pick = namer(theirs);
  const used = new Set<string>();
  return (id, method, path, op) => {
    let name = pick(id, method, path, op);
    if (used.has(name)) name = `${id}_${path.replace(/\{[^}]*\}/g, "").split("/").filter(Boolean).at(-1)}`;
    if (used.has(name)) throw new Error(`can't name ${method} ${path}`);
    used.add(name);
    return name;
  };
}
