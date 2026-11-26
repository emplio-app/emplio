import { Suspense } from "react";
import { ClientsPage } from "@/components/clients/clients-page";

// The app layout renders nothing until the login check finishes, so there is no static shell to validate.
export const instant = false;

export default function Page() {
  // it reads the URL on the client, so it needs a Suspense boundary for the static shell.
  return (
    <Suspense>
      <ClientsPage />
    </Suspense>
  );
}
