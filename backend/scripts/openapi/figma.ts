// Figma: what the generator (../openapi-actions.ts) can't tell from the spec (github.com/figma/rest-api-spec).
import type { AppConfig } from "../openapi-actions";
import { composioNames, namer } from "./composio-names";

const PLAN_TOKEN = "needs a plan access token or an organization's OAuth app; Emplio connects with a personal access token";
const ENTERPRISE_OAUTH = "only a private OAuth app on an Enterprise plan can call it; Emplio connects with a personal access token";

export default {
  spec: "https://raw.githubusercontent.com/figma/rest-api-spec/main/openapi/openapi.yaml",
  out: "src/integrations/own/figma/actions.json",
  name: namer(await composioNames("figma")),
  // Figma renamed projects to folders; Composio's names for the v2 folder calls that replace the deprecated project ones
  // Figma renamed projects to folders; Composio's names for the v2 folder calls that replace the deprecated project ones
  rename: { get_top_level_folders_in_team: "get_projects_in_a_team", get_files_in_folder: "get_files_in_a_project" },
  params: {
    file_key: "The file's key: in its link, the part after /design/, /file/, /board/ or /slides/ (figma.com/design/AbC123xyz/Homepage → AbC123xyz). A branch's key works too",
    team_id: "The team's id: the number after /team/ in the team's link (figma.com/files/team/1170245155647481265/...)",
    folder_id: "The folder's id (Figma used to call folders projects): the number after /project/ in the folder's link (figma.com/files/project/123456789/...)",
  },
  skip: {
    postFileDuplicate: ENTERPRISE_OAUTH,
    postTeam: ENTERPRISE_OAUTH,
    postTeamInvites: ENTERPRISE_OAUTH,
    postTeamFolder: ENTERPRISE_OAUTH,
    getTeam: PLAN_TOKEN,
    getFolderMeta: PLAN_TOKEN,
    getActivityLogs: PLAN_TOKEN,
    getDeveloperLogs: PLAN_TOKEN,
    getAiUsageDaily: PLAN_TOKEN,
    getTeamProjects: "deprecated by Figma; get_projects_in_a_team (team folders) replaces it",
    getProjectFiles: "deprecated by Figma; get_files_in_a_project (folder files) replaces it",
    getProjectMeta: "deprecated by Figma; folders replace projects",
    getTeamWebhooks: "deprecated by Figma; get_webhooks with context team does the same",
  },
} satisfies AppConfig;
