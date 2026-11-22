// Help content: the knowledge base (solution categories, folders and articles, in every language), canned
// responses (saved replies) and community forums.
import { z } from "zod";
import type { OwnAction } from "../index";
import { files, id, page, r, withFiles } from "./client";

const lang = z.string().min(2).describe("Language code of the translation, e.g. fr, de, es, pt-BR");
const categoryId = id("solution category", "freshdesk.list_solution_categories");
const folderId = id("solution folder", "freshdesk.list_solution_folders");
const articleId = id("article", "freshdesk.list_solution_articles or search_solution_articles");

const categoryFields = {
  name: z.string().optional().describe("Category name (unique; required on create)"),
  description: z.string().optional().describe("About it"),
  visible_in_portals: z.array(z.number().int()).optional().describe("Portal ids it shows in (several products)"),
};
const folderFields = {
  name: z.string().optional().describe("Folder name (unique; required on create)"),
  description: z.string().optional().describe("About it"),
  parent_folder_id: z.number().int().optional().describe("Put it inside this folder"),
  visibility: z.number().int().optional().describe("Who sees it: 1 everyone, 2 logged-in users, 3 agents only, 4 certain companies, 5 bot, 6 certain contact segments, 7 certain company segments"),
  company_ids: z.array(z.number().int()).optional().describe("With visibility 4: the companies"),
  contact_segment_ids: z.array(z.number().int()).optional().describe("With visibility 6: the contact segments"),
  company_segment_ids: z.array(z.number().int()).optional().describe("With visibility 7: the company segments"),
};
const articleFields = {
  title: z.string().optional().describe("Article title (required on create)"),
  description: z.string().optional().describe("The article, in HTML (required on create)"),
  status: z.number().int().optional().describe("1 draft, 2 published (required on create)"),
  tags: z.array(z.string()).optional().describe("Tags"),
  seo_data: z.object({ meta_title: z.string().optional(), meta_description: z.string().optional(), meta_keywords: z.string().optional() }).optional().describe("Search engine title, description and keywords"),
  agent_id: z.number().int().optional().describe("Author (on update)"),
};

const cannedFields = {
  title: z.string().optional().describe("Name of the saved reply (required on create)"),
  content_html: z.string().optional().describe("The reply, in HTML; placeholders like {{ticket.requester.name}} work (required on create)"),
  folder_id: z.number().int().optional().describe("Folder it goes in (freshdesk.get_canned_response_folders; required on create)"),
  visibility: z.number().int().optional().describe("Who can use it: 0 all agents, 1 only you, 2 certain groups (required on create)"),
  group_ids: z.array(z.number().int()).optional().describe("With visibility 2: the groups"),
  attachments: files,
};

const forumFields = {
  name: z.string().optional().describe("Forum name (unique; required on create)"),
  description: z.string().optional().describe("About it"),
  forum_type: z.number().int().optional().describe("1 How-tos, 2 Ideas, 3 Problems, 4 Announcements (required on create)"),
  forum_visibility: z.number().int().optional().describe("1 everyone, 2 logged-in users, 3 agents only, 4 certain companies (required on create)"),
  company_ids: z.array(z.number().int()).optional().describe("With visibility 4: the companies"),
};
const topicFields = {
  title: z.string().optional().describe("Topic title (required on create)"),
  message: z.string().optional().describe("The first post, in HTML (required on create)"),
  locked: z.boolean().optional().describe("No more replies"),
  sticky: z.boolean().optional().describe("Keep it at the top"),
  stamp_type: z.number().int().optional().describe("Status stamp. Ideas: 1 planned, 2 implemented, 3 taking no action; questions: 6 answered, 7 unanswered; problems: 8 solved, 9 unsolved"),
};
const userQuery = z.number().int().describe("The agent or contact's id");

export const knowledgeActions: Record<string, OwnAction> = {
  // ── knowledge base: categories
  list_solution_categories: r("GET", "/solutions/categories", "Knowledge base categories (the top level)."),
  view_solution_category: r("GET", "/solutions/categories/{id}", "One knowledge base category.", { id: categoryId }),
  create_solution_category: r("POST", "/solutions/categories", "Add a knowledge base category.", categoryFields),
  update_solution_category: r("PUT", "/solutions/categories/{id}", "Rename or change a knowledge base category.", { id: categoryId, ...categoryFields }),
  delete_solution_category: r("DELETE", "/solutions/categories/{id}", "Delete a category with its folders and articles.", { id: categoryId }),
  list_translated_solution_categories: r("GET", "/solutions/categories/{language_code}", "Knowledge base categories in one language.", { language_code: lang }),
  get_translated_solution_category: r("GET", "/solutions/categories/{id}/{language_code}", "One category's translation.", { id: categoryId, language_code: lang }),
  create_translated_solution_category: r("POST", "/solutions/categories/{id}/{language_code}", "Add a translation of a category.", { id: categoryId, language_code: lang, ...categoryFields }),
  update_translated_solution_category: r("PUT", "/solutions/categories/{id}/{language_code}", "Change a category's translation.", { id: categoryId, language_code: lang, ...categoryFields }),

  // ── knowledge base: folders
  list_solution_folders: r("GET", "/solutions/categories/{id}/folders", "Folders in a knowledge base category.", { id: categoryId }),
  list_solution_subfolders: r("GET", "/solutions/folders/{id}/subfolders", "Folders inside a folder.", { id: folderId }),
  view_solution_folder: r("GET", "/solutions/folders/{id}", "One knowledge base folder.", { id: folderId }),
  create_solution_folder: r("POST", "/solutions/categories/{id}/folders", "Add a folder to a knowledge base category.", { id: categoryId, ...folderFields }),
  update_solution_folder: r("PUT", "/solutions/folders/{id}", "Change a folder: name, visibility, parent.", { id: folderId, ...folderFields }),
  delete_solution_folder: r("DELETE", "/solutions/folders/{id}", "Delete a folder with its articles.", { id: folderId }),
  list_solutions_category_folders_translated: r("GET", "/solutions/categories/{id}/folders/{language_code}", "A category's folders in one language.", { id: categoryId, language_code: lang }),
  list_translated_subfolders: r("GET", "/solutions/folders/{id}/subfolders/{language_code}", "Folders inside a folder, in one language.", { id: folderId, language_code: lang }),
  view_translated_solution_folder: r("GET", "/solutions/folders/{id}/{language_code}", "One folder's translation.", { id: folderId, language_code: lang }),
  create_translated_solution_folder: r("POST", "/solutions/folders/{id}/{language_code}", "Add a translation of a folder.", { id: folderId, language_code: lang, ...folderFields }),
  update_translated_solution_folder: r("PUT", "/solutions/folders/{id}/{language_code}", "Change a folder's translation.", { id: folderId, language_code: lang, ...folderFields }),

  // ── knowledge base: articles
  list_solution_articles: r("GET", "/solutions/folders/{id}/articles", "Articles in a knowledge base folder.", { id: folderId, ...page }),
  search_solution_articles: r("GET", "/search/solutions", "Find knowledge base articles by words in them.", { term: z.string().min(1).describe("Words to look for"), ...page }),
  view_solution_article: r("GET", "/solutions/articles/{id}", "One article with its full text.", { id: articleId }),
  create_solution_article: r("POST", "/solutions/folders/{id}/articles", "Write a knowledge base article in a folder (status 1 draft, 2 published).", { id: folderId, ...articleFields }),
  update_solution_article: r("PUT", "/solutions/articles/{id}", "Change an article; status 2 publishes it.", { id: articleId, ...articleFields }),
  delete_solution_article: r("DELETE", "/solutions/articles/{id}", "Delete an article.", { id: articleId }),
  list_translated_solution_articles: r("GET", "/solutions/folders/{id}/articles/{language_code}", "Articles in a folder, in one language.", { id: folderId, language_code: lang, ...page }),
  view_translated_solution_article: r("GET", "/solutions/articles/{id}/{language_code}", "One article's translation.", { id: articleId, language_code: lang }),
  create_translated_solution_article: r("POST", "/solutions/articles/{id}/{language_code}", "Add a translation of an article.", { id: articleId, language_code: lang, ...articleFields }),
  update_translated_solution_article: r("PUT", "/solutions/articles/{id}/{language_code}", "Change an article's translation.", { id: articleId, language_code: lang, ...articleFields }),

  // ── canned responses (saved replies)
  get_canned_response_folders: r("GET", "/canned_response_folders", "Folders of saved replies."),
  get_canned_response_folder: r("GET", "/canned_response_folders/{id}", "A saved-reply folder and the replies in it (titles).", { id: id("folder", "freshdesk.get_canned_response_folders") }),
  get_folder_responses: r("GET", "/canned_response_folders/{id}/responses", "Every saved reply in a folder, with full text.", { id: id("folder", "freshdesk.get_canned_response_folders") }),
  create_canned_response_folder: r("POST", "/canned_response_folders", "Add a folder for saved replies.", { name: z.string().min(1).describe("Folder name") }),
  update_canned_response_folder: r("PUT", "/canned_response_folders/{id}", "Rename a saved-reply folder.", { id: id("folder"), name: z.string().min(1).describe("New name") }),
  view_a_canned_response: r("GET", "/canned_responses/{id}", "One saved reply with its text.", { id: id("canned response", "freshdesk.get_folder_responses") }),
  create_canned_response: withFiles("POST", "/canned_responses", "Save a reply agents can reuse.", cannedFields),
  update_canned_response: withFiles("PUT", "/canned_responses/{id}", "Change a saved reply.", { id: id("canned response"), ...cannedFields }),
  create_canned_response_bulk: r("POST", "/canned_responses/bulk", "Save many replies at once in the background (answers a job id).", {
    canned_responses: z.array(z.record(z.string(), z.any())).min(1).describe('Replies, e.g. [{"title": "Refund", "content_html": "...", "folder_id": 8, "visibility": 0}]'),
  }),

  // ── community forums
  list_discussions: r("GET", "/discussions/categories", "Forum categories in the community portal."),
  get_discussion_category: r("GET", "/discussions/categories/{id}", "One forum category.", { id: id("forum category") }),
  create_discussion_category: r("POST", "/discussions/categories", "Add a forum category.", { name: z.string().min(1).describe("Name (unique)"), description: z.string().optional().describe("About it") }),
  update_discussion_category: r("PUT", "/discussions/categories/{id}", "Rename or describe a forum category.", { id: id("forum category"), name: z.string().optional(), description: z.string().optional() }),
  delete_discussion_category: r("DELETE", "/discussions/categories/{id}", "Delete a forum category with its forums.", { id: id("forum category") }),
  list_forums_in_category: r("GET", "/discussions/categories/{id}/forums", "Forums in a category.", { id: id("forum category") }),
  create_forum: r("POST", "/discussions/categories/{id}/forums", "Add a forum to a category.", { id: id("forum category"), ...forumFields }),
  view_forum: r("GET", "/discussions/forums/{id}", "One forum.", { id: id("forum") }),
  update_discussion_forum: r("PUT", "/discussions/forums/{id}", "Change a forum.", { id: id("forum"), forum_category_id: z.number().int().optional().describe("Move it to this category"), ...forumFields }),
  delete_discussion_forum: r("DELETE", "/discussions/forums/{id}", "Delete a forum with its topics.", { id: id("forum") }),
  monitor_forum: r("POST", "/discussions/forums/{id}/follow", "Follow a forum (emails on new topics).", { id: id("forum"), user_id: userQuery.optional() }),
  delete_discussions_forums_follow: r("DELETE", "/discussions/forums/{id}/follow", "Stop following a forum.", { id: id("forum"), user_id: userQuery }),
  get_forum_follow_status: r("GET", "/discussions/forums/{id}/follow", "Whether someone follows a forum.", { id: id("forum"), user_id: userQuery }),
  list_discussions_topics: r("GET", "/discussions/forums/{id}/topics", "Topics in a forum.", { id: id("forum"), ...page }),
  create_discussion_forum_topic: r("POST", "/discussions/forums/{id}/topics", "Start a topic in a forum.", { id: id("forum"), ...topicFields }),
  get_discussion_topic: r("GET", "/discussions/topics/{id}", "One topic.", { id: id("topic") }),
  update_discussion_topic: r("PUT", "/discussions/topics/{id}", "Change a topic: title, text, locked, sticky, stamp.", { id: id("topic"), forum_id: z.number().int().optional().describe("Move it to this forum"), ...topicFields }),
  delete_discussion_topic: r("DELETE", "/discussions/topics/{id}", "Delete a topic with its comments.", { id: id("topic") }),
  monitor_topic: r("POST", "/discussions/topics/{id}/follow", "Follow a topic (emails on new comments).", { id: id("topic"), user_id: userQuery.optional() }),
  delete_discussions_topics_follow: r("DELETE", "/discussions/topics/{id}/follow", "Stop following a topic.", { id: id("topic"), user_id: userQuery }),
  get_topic_follow_status: r("GET", "/discussions/topics/{id}/follow", "Whether someone follows a topic.", { id: id("topic"), user_id: userQuery }),
  list_monitored_topics: r("GET", "/discussions/topics/followed_by", "Topics someone follows.", { user_id: userQuery, ...page }),
  list_participated_topics: r("GET", "/discussions/topics/participated_by", "Topics someone has posted in.", { user_id: userQuery, ...page }),
  list_topic_comments: r("GET", "/discussions/topics/{id}/comments", "Comments on a topic.", { id: id("topic"), ...page }),
  create_discussion_topic_comment: r("POST", "/discussions/topics/{id}/comments", "Comment on a topic.", { id: id("topic"), body: z.string().min(1).describe("The comment, in HTML") }),
  update_discussion_comment: r("PUT", "/discussions/comments/{id}", "Edit a comment, or mark it as the answer.", { id: id("comment"), body: z.string().optional().describe("New text, HTML"), answer: z.boolean().optional().describe("Mark as the answer (question topics)") }),
  delete_discussion_comment: r("DELETE", "/discussions/comments/{id}", "Delete a comment.", { id: id("comment") }),
};
