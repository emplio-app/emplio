// emplio.app/download/mac: the Emplio app for Mac. The browser stays on our own site and the file downloads at once:
// the server fetches it from the backend (which keeps it in our S3 bucket) and passes it straight through.
// MAC_DOWNLOAD_TARGET can point somewhere else instead.
export async function GET() {
  const file = await fetch(process.env.MAC_DOWNLOAD_TARGET || `${process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"}/download/mac`, { redirect: "follow" }).catch(() => null);
  if (!file?.ok || !file.body) return new Response("The Mac app is not available yet. Please try again soon.", { status: 503 });
  const headers = new Headers({ "content-type": "application/x-apple-diskimage", "content-disposition": 'attachment; filename="Emplio.dmg"', "cache-control": "public, max-age=300" });
  const size = file.headers.get("content-length");
  if (size) headers.set("content-length", size);
  return new Response(file.body, { headers });
}
