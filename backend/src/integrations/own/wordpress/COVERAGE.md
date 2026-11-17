# WordPress coverage

Source: the REST API index (`/wp-json/`) of a fresh WordPress 6.9 install with no plugins (WordPress Playground),
dumped 2026-11-16. WordPress has no OpenAPI spec, but every site describes its own routes and their arguments at
`/wp-json/`; `bun scripts/openapi/wordpress.ts <site>/wp-json/` turns that into OpenAPI and
`bun scripts/openapi-actions.ts wordpress` generates `actions.json`. Every route and method is an action (203), plus
6 hand-written ones. Benchmark: Composio has no self-hosted WordPress toolkit, only `wordpress_com` (26 tools, OAuth,
no triggers), checked with `.claude/skills/new-integration/coverage.ts wordpress wordpress_com`. Tried live against
the Playground install (posts, publish, categories, plugins on/off, media upload, comments, every poll).

## Sign-in, and why

Most small businesses run self-hosted WordPress on shared hosting (Hostinger, GoDaddy, Bluehost...), not on
WordPress.com. WordPress core (5.6+) has **Application Passwords**: the owner makes one in their own profile, it works
with Basic auth on the core REST API, it can be revoked on its own, and it needs no plugin and no app registration.
That reaches the most sites, so it is the key:

    <site address> <username> <application password>

on one line (the password may keep WordPress's spaces; usernames may have spaces). Requests go to
`<site>/wp-json/...`, the host taken from the key (`url` on the `Api`, as Plivo and LiveKit carry parts of their key).

**WordPress.com** sites (and Jetpack-connected ones) use OAuth2 through public-api.wordpress.com instead. `oauth`
reads `WORDPRESS_CLIENT_ID` / `WORDPRESS_CLIENT_SECRET` and is off until they are set. The person picks one site on
the consent screen; the token never expires and works for that site only. It is stored as `wpcom <blog id> <token>`, and
the same actions run against `public-api.wordpress.com/<namespace>/sites/<blog>/...`, so one action list serves both.

| Method | Status |
| --- | --- |
| Application Password (self-hosted, WordPress 5.6+, https) | done, tried live on a local install |
| WordPress.com OAuth (`WORDPRESS_CLIENT_ID`, `WORDPRESS_CLIENT_SECRET`) | built; app not registered, not tried live |

Callback to register: `https://api.emplio.app/oauth/wordpress/callback` (developer.wordpress.com/apps).

Guards: the key's address must be public https (WordPress itself only offers Application Passwords on https, and
the password must not go to a machine on our network). `check` tells plain-permalink sites (no `/wp-json/`) to switch
Settings → Permalinks to "Post name", and says when a host or security plugin drops the login header.

## Deliberately left out

| What | Why |
| --- | --- |
| Routes plugins add (WooCommerce, Yoast, Jetpack, forms...) | Differ per site; `call_api_get` / `call_api` reach any of them, and `get_api_index` lists what this site has |
| Stats on a self-hosted site without Jetpack | Core WordPress keeps no visitor stats. With Jetpack, sign in through WordPress.com for the stats actions |
| Composio's `list_sites`, `list_blogging_prompts`, `list_reader_subscriptions` | WordPress.com account and Reader features, not managing a business's site; a connection is one site |
| Composio's `create/update/delete_draft_post`, `list_site_posts`, `update_site_menu`, `list_content`, `list_cms_resources` | Same thing under core names: `create_post` with status draft, `list_posts`, `update_menu`, `search_content`, `list_types` |
| `PUT` / `PATCH` | Same as `POST` on every route |

## Hand adjustments (scripts/openapi/wordpress.ts, own/wordpress/index.ts)

- Names follow the route: `list_posts`, `get_post`, `update_post`, `list_post_revisions`; a few by hand (`get_site_settings`, `update_site_settings`, `search_content`, `run_ability`, `get_current_user`...).
- `title`, `content`, `excerpt`, `caption` take a plain string (WordPress also takes `{"raw": ...}`).
- Lists in the query go comma-separated (WordPress keeps only the last of a repeated key).
- WordPress's argument defaults are only described, never sent, so an update can't overwrite a field with a default.
- `create_media` is a multipart upload with the file.
- Plugin and template ids keep their slash in the path (`akismet/akismet`, `theme//home`).
- Lookups that are POSTs run unasked: `encode_widget_form`, `render_widget_preview`.
- `create_user_application_password` asks first and says it shows a secret.
- Notes for the actions people use most (posts, pages, media, comments, plugins, settings, menus).

## Triggers

No core webhooks (they need a plugin), so all 8 are polled every 5 minutes (`polls/wordpress.ts`), the newest 50 each:
`new_post`, `post_published`, `post_updated`, `new_page`, `page_updated`, `new_comment`, `new_user`, `new_media`.
"Changed" triggers use `<id>:<modified_gmt>` as the id. Filters: status, a post's comments, user roles, media type.
`new_user` needs an Administrator login. Composio has none.

## Actions by group (* asks first)

**hand-written** (6): call_api_get, call_api*, get_site_overview, get_detailed_site_stats, get_visit_stats, get_stats_report

**index** (2): get_api_index, batch_requests*

**oembed/1.0** (2): get_oembed, get_oembed_proxy

**wp/v2** (184): list_posts, create_post*, get_post, update_post*, delete_post*, list_post_revisions, get_post_revision, delete_post_revision*, list_post_autosaves, create_post_autosave*, get_post_autosave, list_pages, create_page*, get_page, update_page*, delete_page*, list_page_revisions, get_page_revision, delete_page_revision*, list_page_autosaves, create_page_autosave*, get_page_autosave, list_media, create_media*, get_media, update_media*, delete_media*, post_process_media*, edit_media_image*, list_menu_items, create_menu_item*, get_menu_item, update_menu_item*, delete_menu_item*, list_menu_item_autosaves, create_menu_item_autosave*, get_menu_item_autosave, list_blocks, create_block*, get_block, update_block*, delete_block*, list_block_revisions, get_block_revision, delete_block_revision*, list_block_autosaves, create_block_autosave*, get_block_autosave, list_template_revisions, get_template_revision, delete_template_revision*, list_template_autosaves, create_template_autosave*, get_template_autosave, list_templates, create_template*, lookup_template, get_template, update_template*, delete_template*, list_template_part_revisions, get_template_part_revision, delete_template_part_revision*, list_template_part_autosaves, create_template_part_autosave*, get_template_part_autosave, list_template_parts, create_template_part*, lookup_template_part, get_template_part, update_template_part*, delete_template_part*, list_global_style_revisions, get_global_style_revision, list_global_style_theme_variations, get_global_style_theme, get_global_style, update_global_style*, list_navigation, create_navigation*, get_navigation, update_navigation*, delete_navigation*, list_navigation_revisions, get_navigation_revision, delete_navigation_revision*, list_navigation_autosaves, create_navigation_autosave*, get_navigation_autosave, list_font_families, create_font_family*, get_font_family, update_font_family*, delete_font_family*, list_font_family_font_faces, create_font_family_font_face*, get_font_family_font_face, delete_font_family_font_face*, list_types, get_type, list_statuses, get_status, list_taxonomies, get_taxonomy, list_categories, create_category*, get_category, update_category*, delete_category*, list_tags, create_tag*, get_tag, update_tag*, delete_tag*, list_menus, create_menu*, get_menu, update_menu*, delete_menu*, list_wp_pattern_category, create_wp_pattern_category*, get_wp_pattern_category, update_wp_pattern_category*, delete_wp_pattern_category*, list_users, create_user*, get_user, update_user*, delete_user*, get_current_user, update_current_user*, delete_current_user*, list_user_application_passwords, create_user_application_password*, delete_all_user_application_passwords*, get_current_application_password, get_user_application_password, update_user_application_password*, delete_user_application_password*, list_comments, create_comment*, get_comment, update_comment*, delete_comment*, search_content, render_block, list_block_types, list_namespace_block_types, get_block_type, get_site_settings, update_site_settings*, list_themes, get_theme, list_plugins, create_plugin*, get_plugin, update_plugin*, delete_plugin*, list_sidebars, get_sidebar, update_sidebar*, list_widget_types, get_widget_type, encode_widget_form, render_widget_preview, list_widgets, create_widget*, get_widget, update_widget*, delete_widget*, search_block_directory, search_pattern_directory, list_block_patterns, list_block_pattern_categories, list_menu_locations, get_menu_location, list_font_collections, get_font_collection, list_icons, list_collection_icons, get_icon, list_icon_collections, get_icon_collection, get_view_config

**wp-site-health/v1** (7): run_site_health_test_background_updates, run_site_health_test_loopback_requests, run_site_health_test_https_status, run_site_health_test_dotorg_communication, run_site_health_test_authorization_header, get_site_health_directory_sizes, run_site_health_test_page_cache

**wp-block-editor/v1** (3): get_url_details, export_theme, get_navigation_fallback

**wp-abilities/v1** (5): list_ability_categories, get_ability_category, run_ability*, list_abilities, get_ability
