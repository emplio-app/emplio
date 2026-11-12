// The models a business can pick as its AI employee's brain: OpenRouter's catalogue, cut to the makers in
// MODEL_PROVIDERS and to models that read text and images, write only text and can use tools (the agent
// works through tools). PDFs and other files reach every one of them: OpenRouter passes them to a model
// that reads files and turns them into text for one that doesn't.
import { MODEL_PROVIDERS, modelFor, type ModelJob, type ModelOption, type Settings } from "@emplio/shared";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import type { FastifyInstance } from "fastify";
import { context } from "./auth";
import type { Bill } from "./credit";
import { cloud } from "./cloud";

type Raw = {
  id: string;
  name: string;
  context_length: number;
  architecture: { input_modalities: string[]; output_modalities: string[] };
  pricing: { prompt: string; completion: string };
  supported_parameters?: string[];
};

// each maker's family, so Google's image and music models, Gemma etc. stay out
const FAMILY: Record<string, RegExp> = { google: /gemini/, "x-ai": /grok/, "z-ai": /glm/ };

const fits = (m: Raw) => {
  const [provider, rest = ""] = m.id.split("/");
  const { input_modalities: input, output_modalities: output } = m.architecture;
  return (
    MODEL_PROVIDERS.some((p) => p.key === provider) &&
    !rest.includes(":") && // the :batch and :free copies of a model
    (FAMILY[provider!]?.test(rest) ?? true) &&
    input.includes("text") &&
    input.includes("image") &&
    output.length === 1 &&
    output[0] === "text" &&
    !!m.supported_parameters?.includes("tools")
  );
};

const perMillion = (price: string) => Math.round(Number(price) * 1e6 * 1000) / 1000;

// models: the picker's list; tools: every OpenRouter model id, and whether it can use tools (a custom pick)
let cached: { at: number; models: ModelOption[]; tools: Map<string, boolean> } | null = null;
const FRESH_MS = 60 * 60 * 1000;

// Newest first within each maker (OpenRouter lists newest first). A failed refresh keeps the last list.
export const listModels = async () => (await catalogue()).models;

// A model typed in by name ("Custom" in the picker): any OpenRouter model, if it can use tools (the agent
// works through them). null when it can; else why not.
export async function customModelProblem(id: string) {
  const tools = (await catalogue()).tools.get(id);
  return tools === undefined ? "OpenRouter has no model by that name." : tools ? null : "that model can't use tools, which Emplio needs.";
}

async function catalogue() {
  if (cached && Date.now() - cached.at < FRESH_MS) return cached;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`OpenRouter models: ${res.status}`);
    const { data } = (await res.json()) as { data: Raw[] };
    const models = data.filter(fits).map((m) => ({
      id: m.id,
      name: m.name.replace(/^[^:]+:\s*/, ""), // "OpenAI: GPT-5" → "GPT-5"
      provider: m.id.split("/")[0] as ModelOption["provider"],
      context: m.context_length,
      input: perMillion(m.pricing.prompt),
      output: perMillion(m.pricing.completion),
    }));
    cached = { at: Date.now(), models, tools: new Map(data.map((m) => [m.id, !!m.supported_parameters?.includes("tools")])) };
  } catch (error) {
    if (!cached) throw error;
  }
  return cached;
}

// Hosts the free router may not use: Google AI Studio's free pool is nearly always rate-limited, and
// AtlasCloud's preview models break off mid-reply. ponytail: hand-kept; revisit when free replies fail again
const FREE_SKIP = ["google-ai-studio", "atlas-cloud"];
// Only hosts that neither keep nor train on what we send: chats can hold the business's Google data, which
// Google's Limited Use rules say may never train AI models (privacy page says so too). This can leave the
// free router with fewer, slower hosts.
const routing = (id: string) => ({ provider: { data_collection: "deny" as const, ...(id === "openrouter/free" ? { ignore: FREE_SKIP } : {}) } });

// What OpenRouter charged for one call (its usage.cost, in dollars), taken from the business's credit (credit.ts).
const costOf = (usage: { raw?: unknown }) => Number((usage.raw as { cost?: number } | undefined)?.cost ?? 0);
const metering = (bill: Bill, id: string, ownKey: boolean): LanguageModelMiddleware => ({
  specificationVersion: "v4",
  wrapGenerate: async ({ doGenerate }) => {
    const result = await doGenerate();
    cloud.credit.chargeQuietly(bill, "ai", costOf(result.usage), bill.agent ? `${id} · ${bill.agent}` : id, { ownKey });
    return result;
  },
  wrapStream: async ({ doStream }) => {
    const result = await doStream();
    const stream = result.stream.pipeThrough(
      new TransformStream({
        transform(part, out) {
          if (part.type === "finish") cloud.credit.chargeQuietly(bill, "ai", costOf(part.usage), bill.agent ? `${id} · ${bill.agent}` : id, { ownKey });
          out.enqueue(part);
        },
      }),
    );
    return { ...result, stream };
  },
});

// Names the app on OpenRouter (its activity page and app rankings) for every request
const attribution = { appName: "Emplio", appUrl: "https://emplio.app" };
// ours reads OPENROUTER_API_KEY from the environment, like the provider's default instance did
const ours = createOpenRouter(attribution);

// A model to run, on the business's own OpenRouter key when it gave one, else on ours; each call's cost is
// charged to `bill`'s business.
export const model = (settings: Pick<Settings, "openrouterKey">, id: string, bill: Bill) =>
  wrapLanguageModel({
    model: (settings.openrouterKey ? createOpenRouter({ apiKey: settings.openrouterKey, ...attribution }) : ours)(id, routing(id)),
    middleware: metering(bill, id, !!settings.openrouterKey),
  });

// The model a job runs on (modelFor), ready to call.
export const modelForJob = <J extends ModelJob>(settings: Pick<Settings, "modelSet" | "openrouterKey" | J>, job: J, bill: Bill) =>
  model(settings, modelFor(settings, job), bill);

export async function modelRoutes(app: FastifyInstance) {
  app.get("/models", async (req, reply) => {
    if (!(await context(req, reply))) return;
    return listModels();
  });
}
