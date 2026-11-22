// Figma news its webhooks don't send: a new folder in a team, and files added or edited in a folder for people who can
// only view it (webhooks need edit rights). Comments, versions, edits and the rest come by webhook (own/figma/triggers.ts).
import { z } from "zod";
import { recent, type PollTrigger } from "./index";

const id = (word: string, s: string) => new RegExp(`/${word}/(\\d+)`).exec(s)?.[1] ?? s.trim();

export const figma: Record<string, PollTrigger> = {
  new_project_in_team: {
    description: "A folder (Figma used to call them projects) is added to a Figma team (checked every 15 minutes).",
    config: z.object({ team_id: z.string().describe("The team: its link (figma.com/files/team/1170245155647481265/...) or id") }),
    output: [{ name: "folder", type: "object", required: true, description: "The folder: id, name, created_at. get_files_in_a_project lists its files" }],
    every: 15,
    min: 5,
    poll: async (c, run) => {
      const out = (await run("figma.get_projects_in_a_team", { team_id: id("team", c.team_id) })) as { folders?: { id: string; created_at?: string }[] };
      return (out.folders ?? []).filter((f) => recent(f.created_at)).map((f) => ({ id: String(f.id), item: { folder: f } }));
    },
  },
  file_changed_in_project: {
    description: "A file in a Figma folder (project) is added or edited (checked every 15 minutes). Works with view access; file_updated tells at once but needs edit rights.",
    config: z.object({ folder_id: z.string().describe("The folder: its link (figma.com/files/project/123456789/...) or id") }),
    output: [{ name: "file", type: "object", required: true, description: "The file: key, name, thumbnail_url, last_modified" }],
    every: 15,
    min: 5,
    poll: async (c, run) => {
      const out = (await run("figma.get_files_in_a_project", { folder_id: id("project", c.folder_id) })) as { files?: { key: string; last_modified?: string }[] };
      // an edit changes last_modified, and is news again
      return (out.files ?? []).filter((f) => recent(f.last_modified)).map((f) => ({ id: `${f.key}:${f.last_modified}`, item: { file: f } }));
    },
  },
};
