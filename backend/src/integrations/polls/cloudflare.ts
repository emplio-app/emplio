import { z } from "zod";
import { recent, type PollTrigger, type Run } from "./index";

// What Cloudflare's Notifications don't send (own/cloudflare/triggers.ts has the alerts): new zones and DNS changes,
// finished Pages builds and Worker deployments without setting up an alert, certificates and domains running out,
// and anything in the audit log.
// ponytail: one page of each list (50 zones, 5000 DNS records, 25 deployments); a longer list may miss rows past it
const ACCOUNT = z.string().describe("The Cloudflare account's id (cloudflare.list_accounts lists them)");
const ZONE = z.string().describe("The zone's (domain's) id (cloudflare.list_zones lists them)");
const DAY = 86_400_000;

const trigger = <T extends z.ZodRawShape>(
  description: string,
  field: string,
  shape: T,
  list: (config: z.infer<z.ZodObject<T>>, run: Run) => Promise<any[]>,
  id: (row: any) => string = (row) => String(row.id),
  every = 5,
): PollTrigger => ({
  description,
  config: z.object(shape),
  output: [{ name: field, type: "object", required: true, description: `Cloudflare's ${field.replace(/_/g, " ")}` }],
  every,
  min: every,
  async poll(config, run) {
    return (await list(config, run)).map((row) => ({ id: id(row), item: { [field]: row } }));
  },
});

const result = (out: unknown) => ((out as { result?: any }).result ?? []) as any[];
const zones = async (c: { account_id?: string }, run: Run) => result(await run("cloudflare.list_zones", { per_page: 50, ...(c.account_id && { "account.id": c.account_id }) }));
const within = (iso: unknown, days: number) => typeof iso === "string" && Date.parse(iso) - Date.now() < days * DAY;
const pagesDone = (d: any) => (d.latest_stage?.name === "deploy" && d.latest_stage?.status === "success") || ["failure", "canceled"].includes(d.latest_stage?.status);

export const cloudflare: Record<string, PollTrigger> = {
  new_zone: trigger("A domain (zone) is added to Cloudflare. Optionally only in one account.", "zone", { account_id: ACCOUNT.optional() }, zones),
  zone_status_changed: trigger(
    "A zone's status changes, like pending → active once its nameservers point at Cloudflare.",
    "zone",
    { account_id: ACCOUNT.optional() },
    zones,
    (z) => `${z.id}:${z.status}`,
  ),
  new_dns_record: trigger("A DNS record is added to a zone.", "dns_record", { zone_id: ZONE }, async (c, run) => result(await run("cloudflare.list_dns_records", { zone_id: c.zone_id, per_page: 5000 }))),
  dns_record_changed: trigger(
    "A DNS record in a zone is added or edited.",
    "dns_record",
    { zone_id: ZONE },
    async (c, run) => result(await run("cloudflare.list_dns_records", { zone_id: c.zone_id, per_page: 5000 })),
    (r) => `${r.id}:${r.modified_on}`,
  ),
  pages_deployment_finished: trigger(
    "A Cloudflare Pages deployment finishes: built and live, failed, or cancelled (latest_stage.status says which). Optionally only failures.",
    "deployment",
    { account_id: ACCOUNT, project_name: z.string().describe("The Pages project's name"), only_failed: z.boolean().optional().describe("Only failed or cancelled deployments") },
    async (c, run) =>
      result(await run("cloudflare.list_pages_deployments", { account_id: c.account_id, project_name: c.project_name, per_page: 25 }))
        .filter((d) => recent(d.created_on) && pagesDone(d))
        .filter((d) => !c.only_failed || d.latest_stage?.status !== "success"),
    (d) => `${d.id}:${d.latest_stage?.status}`,
  ),
  worker_deployed: trigger(
    "A new version of a Worker is deployed.",
    "deployment",
    { account_id: ACCOUNT, script_name: z.string().describe("The Worker's name") },
    async (c, run) => ((await run("cloudflare.list_worker_deployments", { account_id: c.account_id, script_name: c.script_name })) as any).result?.deployments ?? [],
  ),
  ssl_certificate_expiring: trigger(
    "An SSL certificate on a zone is within some days of expiring (14 unless set). Universal certificates renew by themselves; this catches ones that don't.",
    "certificate_pack",
    { zone_id: ZONE, days: z.number().optional().describe("How many days ahead to warn (default 14)") },
    async (c, run) =>
      result(await run("cloudflare.list_certificate_packs", { zone_id: c.zone_id, per_page: 50 })).filter((p) =>
        (p.certificates ?? []).some((cert: any) => within(cert.expires_on, c.days ?? 14)),
      ),
    (p) => `${p.id}:${p.certificates?.[0]?.expires_on}`,
    60,
  ),
  domain_expiring: trigger(
    "A domain registered with Cloudflare Registrar is within some days of expiring (30 unless set); auto_renew says whether it renews by itself.",
    "registration",
    { account_id: ACCOUNT, days: z.number().optional().describe("How many days ahead to warn (default 30)") },
    async (c, run) =>
      result(await run("cloudflare.registrar_registrations_list", { account_id: c.account_id, per_page: 50, sort_by: "registry_expires_at", direction: "asc" })).filter((r) =>
        within(r.expires_at, c.days ?? 30),
      ),
    (r) => `${r.domain_name}:${r.expires_at}`,
    60,
  ),
  new_audit_log_entry: trigger(
    "Something is changed in the Cloudflare account (its audit log): who did what to which resource. Optionally only one kind of action or product.",
    "audit_log",
    {
      account_id: ACCOUNT,
      action_type: z.string().optional().describe("Only this kind of action: create, delete, update, view…"),
      resource_product: z.string().optional().describe("Only this product, like dns_records, workers, access"),
    },
    async (c, run) =>
      result(
        await run("cloudflare.get_account_audit_logs_version_2", {
          account_id: c.account_id,
          since: new Date(Date.now() - DAY).toISOString(),
          before: new Date().toISOString(),
          limit: 100,
          ...(c.action_type && { action_type: [c.action_type] }),
          ...(c.resource_product && { resource_product: [c.resource_product] }),
        }),
      ),
  ),
};
