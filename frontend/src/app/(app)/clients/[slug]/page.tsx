import { Suspense } from "react";
import { ClientPage } from "@/components/clients/clients-page";

// The app layout renders nothing until the login check finishes, so there is no static shell to validate.
export const instant = false;

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // its side panels read the URL on the client, so it needs a Suspense boundary for the static shell.
  return (
    <Suspense>
      <ClientPage slug={slug} />
    </Suspense>
  );
}
