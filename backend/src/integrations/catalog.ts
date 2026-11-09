import type { AppCategory } from "@emplio/shared";

// The apps we offer: our own names, words and categories. An app shows up (in the Integrations window and
// `emplio apps search`) only when it's here AND its provider has a login set up for it (for Composio: an auth
// config in its dashboard). To offer a new app: add it here, then set up its login in the provider.
export type CatalogApp = { app: string; name: string; category: AppCategory; description: string; provider: "composio" | "own" };

const composio = (app: string, name: string, category: AppCategory, description: string): CatalogApp => ({
  app,
  name,
  category,
  description,
  provider: "composio",
});

// ours (own/): connected with a key the person pastes
const own = (app: string, name: string, category: AppCategory, description: string): CatalogApp => ({
  app,
  name,
  category,
  description,
  provider: "own",
});

export const CATALOG: CatalogApp[] = [
  own("indiamart", "IndiaMART", "crm", "Buyer enquiries and leads from your seller listing"),
  own("exa", "Exa", "productivity", "Web search, page reading, deep research and websets (lists of companies or people, kept up to date) on your own Exa account"),
  own("anthropic", "Anthropic", "ai", "Run Claude models on your own Anthropic account"),
  own("openai", "OpenAI", "ai", "Run GPT models on your own OpenAI account"),
  own("google", "Google AI Studio", "ai", "Run Gemini models on your own Google account"),
  own("openrouter", "OpenRouter", "ai", "Run every other model on your own OpenRouter account; keys, credits, usage, images and embeddings"),
  own("sarvam", "Sarvam AI", "ai", "Speech, translation and voice agents in Indian languages: transcribe, speak, translate, dub, digitise documents, run calling campaigns"),
  composio("gmail", "Gmail", "email", "Read, search, draft and send email"),
  composio("outlook", "Outlook", "email", "Microsoft email and calendar"),
  composio("zoho_mail", "Zoho Mail", "email", "Read and send email from Zoho Mail"),
  composio("googlecalendar", "Google Calendar", "calendar", "See your schedule, create and move events"),
  composio("calendly", "Calendly", "calendar", "Booking links and scheduled meetings"),
  composio("googlemeet", "Google Meet", "calendar", "Create meetings and get recordings"),
  own("fireflies", "Fireflies.ai", "calendar", "Meeting recordings, transcripts, summaries and action items; ask questions across meetings"),
  composio("zoom", "Zoom", "calendar", "Schedule meetings and get recordings"),
  composio("googledocs", "Google Docs", "docs", "Create and edit documents"),
  composio("googledrive", "Google Drive", "docs", "Find, upload and share files"),
  composio("one_drive", "OneDrive", "docs", "Microsoft file storage"),
  composio("notion", "Notion", "docs", "Pages, notes and databases"),
  composio("googlesheets", "Google Sheets", "spreadsheets", "Read and update spreadsheets"),
  composio("airtable", "Airtable", "spreadsheets", "Bases, tables and records"),
  composio("zoho_books", "Zoho Books", "accounting", "Invoices, bills, customers and payments"),
  own("swipe", "Swipe", "accounting", "Invoices, quotes, purchases and e-invoices on Swipe: customers, vendors, products, stock, payments, expenses, e-way bills and GSTIN lookup"),
  composio("zoho_invoice", "Zoho Invoice", "accounting", "Invoices, estimates and payment reminders"),
  composio("zoho", "Zoho CRM", "crm", "Leads, deals and contacts"),
  composio("hubspot", "HubSpot", "crm", "Contacts, deals and email sequences"),
  composio("slack", "Slack", "chat", "Read and post messages in channels"),
  composio("microsoft_teams", "Microsoft Teams", "chat", "Chats and channel messages"),
  own("plivo", "Plivo", "messaging", "SMS, WhatsApp and phone calls on Plivo: send messages, make and control calls, conferences, recordings, numbers, verification"),
  own("msg91", "MSG91", "messaging", "SMS, OTP, WhatsApp, email, voice calls and RCS from your MSG91 account, plus its Hello help desk"),
  composio("whatsapp", "WhatsApp Business", "messaging", "Send and receive WhatsApp messages"),
  composio("stripe", "Stripe", "payments", "Payments, customers and invoices"),
  own("razorpay", "Razorpay", "payments", "Take payments on your own Razorpay account: payment links, invoices, refunds, subscriptions, QR codes, settlements and disputes"),
  composio("todoist", "Todoist", "productivity", "Tasks, projects and comments"),
  composio("asana", "Asana", "productivity", "Projects and tasks"),
  composio("clickup", "ClickUp", "productivity", "Tasks, lists and docs"),
  composio("linkedin", "LinkedIn", "productivity", "Post updates and manage your profile"),
  own("fly", "Fly.io", "developer", "Apps, servers, databases, domains, logs, deploys and billing on Fly.io"),
  own("vercel", "Vercel", "developer", "Websites on Vercel: projects, deploys, logs, domains, DNS, env vars and teams"),
  own("hostinger", "Hostinger", "developer", "Websites, WordPress, VPS servers, domains, DNS and business email on Hostinger"),
  own("neon", "Neon", "developer", "Postgres databases on Neon: run SQL, and manage projects, branches, databases, roles, backups, auth and storage"),
  own("livekit", "LiveKit", "developer", "Live audio/video rooms, recordings and streams, phone calls (SIP), numbers and voice AI agents on LiveKit"),
  own("github", "GitHub", "developer", "Repositories, issues, pull requests and Actions, and git itself on Emplio's computer"),
];

export const catalogApp = (app: string) => CATALOG.find((a) => a.app === app);
