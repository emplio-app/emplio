import { z } from "zod";
import type { PollTrigger } from "./index";

// What GitHub has no webhook for; everything else arrives by webhook (own/github/triggers.ts).
// ponytail: one page of each list, 100 rows; a list longer than that may miss new rows
const REPO = { owner: z.string().describe("Who owns the repository"), repo: z.string().describe("The repository's name") };

const trigger = <T extends z.ZodRawShape>(
  description: string,
  field: string,
  shape: T,
  list: (config: z.infer<z.ZodObject<T>>, run: (action: string, input: unknown) => Promise<any>) => Promise<any[]>,
  id: (row: any) => string = (row) => String(row.id),
): PollTrigger => ({
  description: `${description}.`,
  config: z.object(shape),
  output: [{ name: field, type: "object", required: true, description: `GitHub's ${field}` }],
  every: 5,
  min: 5,
  async poll(config, run) {
    return (await list(config, run)).map((row) => ({ id: id(row), item: { [field]: row } }));
  },
});

export const github: Record<string, PollTrigger> = {
  follower_event: trigger("Someone new follows your GitHub account", "follower", {}, (_c, run) => run("github.list_followers_of_the_authenticated_user", { per_page: 100 })),
  issue_assigned_to_me_trigger: trigger("An issue is assigned to you, in any repository", "issue", {}, async (_c, run) =>
    ((await run("github.list_issues_assigned_to_the_authenticated_user", { filter: "assigned", state: "open", sort: "updated", per_page: 100 })) as any[]).filter((i) => !i.pull_request),
  ),
  repository_notification_received_trigger: trigger(
    "You get a new or updated GitHub notification about a repository",
    "notification",
    REPO,
    (c, run) => run("github.list_repository_notifications_for_the_authenticated_user", { ...c, per_page: 100 }),
    (n) => `${n.id}:${n.updated_at}`,
  ),
  artifact_created_trigger: trigger("A workflow uploads a new artifact in a repository", "artifact", REPO, async (c, run) =>
    (await run("github.list_artifacts_for_a_repository", { ...c, per_page: 100 })).artifacts ?? [],
  ),
  workflow_run_artifact_added: trigger("A new artifact appears on one workflow run", "artifact", { ...REPO, run_id: z.number().describe("The workflow run") }, async (c, run) =>
    (await run("github.list_workflow_run_artifacts", { ...c, per_page: 100 })).artifacts ?? [],
  ),
  workflow_added_trigger: trigger("A new workflow is added to a repository", "workflow", REPO, async (c, run) =>
    (await run("github.list_repository_workflows", { ...c, per_page: 100 })).workflows ?? [],
  ),
  release_asset_added_trigger: trigger("A new file is added to a release", "asset", { ...REPO, release_id: z.number().describe("The release") }, (c, run) =>
    run("github.list_release_assets", { ...c, per_page: 100 }),
  ),
};
