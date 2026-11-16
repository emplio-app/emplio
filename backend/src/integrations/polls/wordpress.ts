import { z } from "zod";
import type { PollTrigger } from "./index";

// WordPress sends no webhooks without a plugin, so every trigger compares the newest items with last time.
// Each list is the newest 50 by date (or by last change), which already keeps the seen list short.
// ponytail: more than 50 new in one check would miss some
const ALL = ["publish", "future", "draft", "pending", "private"];

const STATUS = z.array(z.enum(["publish", "future", "draft", "pending", "private"])).optional().describe("Only these statuses (default all but trash)");

const trigger = <T extends z.ZodRawShape>(
  description: string,
  field: string,
  shape: T,
  list: (config: z.infer<z.ZodObject<T>>, run: (action: string, input: unknown) => Promise<any>) => Promise<any[]>,
  id: (row: any) => string,
): PollTrigger => ({
  description: `${description}.`,
  config: z.object(shape),
  output: [{ name: field, type: "object", required: true, description: `The ${field}, as WordPress's REST API gives it` }],
  every: 5,
  min: 5,
  async poll(config, run) {
    return ((await list(config, run)) ?? []).map((row) => ({ id: id(row), item: { [field]: row } }));
  },
});

const posts = (action: string, orderby: string) => (c: { status?: string[] }, run: (a: string, i: unknown) => Promise<any>) =>
  run(action, { status: c.status ?? ALL, orderby, order: "desc", per_page: 50, context: "edit" });
const byId = (r: any) => String(r.id);
const changed = (r: any) => `${r.id}:${r.modified_gmt}`;

export const wordpress: Record<string, PollTrigger> = {
  new_post: trigger("A new blog post is written, as a draft or published", "post", { status: STATUS }, posts("wordpress.list_posts", "date"), byId),
  post_published: trigger(
    "A blog post goes live on the site",
    "post",
    {},
    (_c, run) => run("wordpress.list_posts", { status: ["publish"], orderby: "date", order: "desc", per_page: 50, context: "edit" }),
    byId,
  ),
  post_updated: trigger(
    "A blog post is changed (any save, including publishing). A run that edits the post itself causes this again",
    "post",
    { status: STATUS },
    posts("wordpress.list_posts", "modified"),
    changed,
  ),
  new_page: trigger("A new page is added to the website", "page", { status: STATUS }, posts("wordpress.list_pages", "date"), byId),
  page_updated: trigger(
    "A page of the website is changed. A run that edits the page itself causes this again",
    "page",
    { status: STATUS },
    posts("wordpress.list_pages", "modified"),
    changed,
  ),
  new_comment: trigger(
    "Someone leaves a comment on the site. A reply Emplio posts is a new comment too",
    "comment",
    {
      status: z.enum(["all", "approve", "hold", "spam"]).optional().describe("all (the default: approved and waiting for moderation), approve, hold (waiting) or spam"),
      post: z.number().int().optional().describe("Only comments on this post or page id"),
    },
    (c, run) => run("wordpress.list_comments", { status: c.status ?? "all", orderby: "date_gmt", order: "desc", per_page: 50, context: "edit", ...(c.post && { post: [c.post] }) }),
    byId,
  ),
  new_user: trigger(
    "A new user account is made on the site (a sign-up or one an admin adds). Needs an Administrator login",
    "user",
    { roles: z.array(z.string()).optional().describe("Only users with one of these roles, like subscriber or customer") },
    (c, run) => run("wordpress.list_users", { orderby: "registered_date", order: "desc", per_page: 50, context: "edit", ...(c.roles && { roles: c.roles }) }),
    byId,
  ),
  new_media: trigger(
    "A new image, video or file is uploaded to the media library",
    "media",
    { media_type: z.enum(["image", "video", "audio", "application", "text"]).optional().describe("Only this kind of file") },
    (c, run) => run("wordpress.list_media", { orderby: "date", order: "desc", per_page: 50, context: "edit", ...(c.media_type && { media_type: c.media_type }) }),
    byId,
  ),
};
