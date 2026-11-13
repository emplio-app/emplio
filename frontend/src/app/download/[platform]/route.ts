// emplio.app/download/mac (or /linux): an Emplio desktop app. The browser stays on our own site and the file downloads at
// once: the server fetches it from the backend (which keeps it in our S3 bucket) and passes it straight through.
const API = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function GET(_req: Request, { params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  const file = await fetch(`${API}/download/${encodeURIComponent(platform)}`).catch(() => null);
  if (!file?.ok || !file.body) return new Response("This app is not available yet. Please try again soon.", { status: 503 });
  const headers = new Headers({ "cache-control": "public, max-age=300" });
  for (const name of ["content-type", "content-disposition", "content-length"]) {
    const value = file.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(file.body, { headers });
}
