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
  own("zoho_mail", "Zoho Mail", "email", "Read, send and sort your company email in Zoho Mail"),
  own("googlecalendar", "Google Calendar", "calendar", "See your schedule, create and move events, find free time, and start work when something changes"),
  own("calendly", "Calendly", "calendar", "Book and cancel meetings, share booking links, and start work the moment someone books, cancels or doesn't show up"),
  own("googlemeet", "Google Meet", "calendar", "Create meeting links, see who joined, read transcripts and meeting notes, and find where recordings are saved"),
  own("fireflies", "Fireflies.ai", "calendar", "Meeting recordings, transcripts, summaries and action items; ask questions across meetings"),
  own("zoom", "Zoom", "calendar", "Schedule meetings and webinars, get recordings and AI summaries, and start work the moment a meeting ends or a recording is ready"),
  own("googledocs", "Google Docs", "docs", "Create documents and edit any document you share the link of, including filling in templates"),
  composio("googledrive", "Google Drive", "docs", "Find, upload and share files"),
  composio("one_drive", "OneDrive", "docs", "Microsoft file storage"),
  own("notion", "Notion", "docs", "Write and update pages and notes, keep databases current, and start work when a page or comment changes"),
  own("googlesheets", "Google Sheets", "spreadsheets", "Read and update any spreadsheet you share the link of, add rows, and start work when one changes"),
  own("airtable", "Airtable", "spreadsheets", "Add and update records in your bases, keep tables in shape, and start work when a record changes"),
  own("zoho_books", "Zoho Books", "accounting", "Send invoices, chase payments and keep your books up to date"),
  own("swipe", "Swipe", "accounting", "Invoices, quotes, purchases and e-invoices on Swipe: customers, vendors, products, stock, payments, expenses, e-way bills and GSTIN lookup"),
  own("zoho_invoice", "Zoho Invoice", "accounting", "Send invoices and estimates and remind customers to pay"),
  own("zoho", "Zoho CRM", "crm", "Keep leads, contacts and deals up to date and follow up on time"),
  own("hubspot", "HubSpot", "crm", "Keep contacts, companies, deals and tickets up to date, send marketing emails, and start work when a lead comes in or a deal moves"),
  own("slack", "Slack", "chat", "Post updates in channels, read and search conversations, share files, set reminders, and start work when someone messages or reacts"),
  composio("microsoft_teams", "Microsoft Teams", "chat", "Chats and channel messages"),
  own("plivo", "Plivo", "messaging", "SMS, WhatsApp and phone calls on Plivo: send messages, make and control calls, conferences, recordings, numbers, verification"),
  own("msg91", "MSG91", "messaging", "SMS, OTP, WhatsApp, email, voice calls and RCS from your MSG91 account, plus its Hello help desk"),
  composio("whatsapp", "WhatsApp Business", "messaging", "Send and receive WhatsApp messages"),
  own("stripe", "Stripe", "payments", "Payments, customers, invoices, subscriptions, refunds, disputes and payouts on your own Stripe account"),
  own("razorpay", "Razorpay", "payments", "Take payments on your own Razorpay account: payment links, invoices, refunds, subscriptions, QR codes, settlements and disputes"),
  own("todoist", "Todoist", "productivity", "Tasks, projects, labels, filters and comments on your Todoist"),
  own("asana", "Asana", "productivity", "Tasks, projects, comments and deadlines on your Asana, and automations when work moves"),
  own("clickup", "ClickUp", "productivity", "Tasks, lists, comments, goals and time tracking on your ClickUp, and automations when work moves"),
  composio("linkedin", "LinkedIn", "productivity", "Post updates and manage your profile"),
  own("fly", "Fly.io", "developer", "Apps, servers, databases, domains, logs, deploys and billing on Fly.io"),
  own("vercel", "Vercel", "developer", "Websites on Vercel: projects, deploys, logs, domains, DNS, env vars and teams"),
  own("hostinger", "Hostinger", "developer", "Websites, WordPress, VPS servers, domains, DNS and business email on Hostinger"),
  own("neon", "Neon", "developer", "Postgres databases on Neon: run SQL, and manage projects, branches, databases, roles, backups, auth and storage"),
  own("livekit", "LiveKit", "developer", "Live audio/video rooms, recordings and streams, phone calls (SIP), numbers and voice AI agents on LiveKit"),
  own("github", "GitHub", "developer", "Repositories, issues, pull requests and Actions, and git itself on Emplio's computer"),
];

export const catalogApp = (app: string) => CATALOG.find((a) => a.app === app);
