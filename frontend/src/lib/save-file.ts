import { toast } from "sonner";

// The iPhone app (mobile/capacitor.config.js adds this to its user agent).
export const inApp = () => typeof navigator !== "undefined" && navigator.userAgent.includes("EmplioApp");

// Saving a file. A browser downloads it. The iPhone app's web view can't download anything (taps did nothing),
// so there it goes to the share sheet, which has Save to Files, AirDrop, Mail and the rest.
export async function saveFile(data: Blob, name: string) {
  const file = new File([data], name, { type: data.type || "application/octet-stream" });
  if (inApp() && navigator.canShare?.({ files: [file] })) return share(file);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

// iOS only opens the share sheet straight from a tap. Making the file can outlast that (a big export, a slow
// network), and then it's one more tap, on the toast.
async function share(file: File) {
  try {
    await navigator.share({ files: [file] });
  } catch (error) {
    const name = (error as Error).name;
    if (name === "NotAllowedError")
      toast(`${file.name} is ready`, { action: { label: "Save", onClick: () => void navigator.share({ files: [file] }).catch(() => {}) } });
    else if (name !== "AbortError") throw error;
  }
}
