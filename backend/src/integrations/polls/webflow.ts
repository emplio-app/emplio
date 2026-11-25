// Webflow things its webhooks don't report: new shop products and new files in the Assets panel.
// Forms, publishes, pages, orders, inventory, CMS items and comments come by webhook (own/webflow/triggers.ts).
import { z } from "zod";
import { recent, type PollTrigger, type Run } from "./index";

const SITE = z.object({ site_id: z.string().optional().describe("The site to watch (its id). Leave out: the site the API token is for") });
// the site in the settings, or the token's only site
const siteOf = async (c: { site_id?: string }, run: Run) => {
  if (c.site_id) return c.site_id;
  const { sites } = (await run("webflow.list_webflow_sites", {})) as { sites?: { id: string }[] };
  if (sites?.length !== 1) throw new Error("site_id: this Webflow token covers several sites; say which one");
  return sites[0]!.id;
};

// ponytail: the newest 100 only; more new ones than that between two polls are missed
export const webflow: Record<string, PollTrigger> = {
  new_product: {
    description: "A product is added to the Webflow site's shop (checked every 5 minutes).",
    config: SITE,
    output: [{ name: "product", type: "object", required: true, description: "The product and its SKUs (variants): product.id, product.fieldData (name, slug, description...), skus with price and fieldData" }],
    every: 5,
    min: 1,
    poll: async (c, run) => {
      const { items } = (await run("webflow.list_products_skus", { site_id: await siteOf(c, run), limit: 100 })) as { items?: any[] };
      return (items ?? []).filter((p) => recent(p.product?.createdOn)).map((p) => ({ id: String(p.product.id), item: { product: p } }));
    },
  },
  new_asset: {
    description: "A file (image, document, video) is added to the Webflow site's Assets panel (checked every 5 minutes).",
    config: SITE,
    output: [{ name: "asset", type: "object", required: true, description: "The asset: id, displayName, originalFileName, contentType, size, hostedUrl, createdOn" }],
    every: 5,
    min: 1,
    poll: async (c, run) => {
      const { assets } = (await run("webflow.list_assets", { site_id: await siteOf(c, run), limit: 100 })) as { assets?: any[] };
      return (assets ?? []).filter((a) => recent(a.createdOn)).map((a) => ({ id: String(a.id), item: { asset: a } }));
    },
  },
};
