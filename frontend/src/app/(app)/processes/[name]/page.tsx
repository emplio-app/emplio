import { ProcessPage } from "@/components/processes/processes-page";

// The app layout renders nothing until the login check finishes, so there is no static shell to validate.
export const instant = false;

export default function Page() {
  return <ProcessPage />;
}
