import { toast } from "sonner";

// The iPhone app (mobile/capacitor.config.js adds this to its user agent).
export const inApp = () => typeof navigator !== "undefined" && navigator.userAgent.includes("EmplioApp");

type Native = {
  Filesystem?: { writeFile(o: { path: string; data: string; directory: "CACHE"; recursive: boolean }): Promise<{ uri: string }> };
  Share?: { share(o: { files: string[] }): Promise<unknown> };
};
const native = () => (window as { Capacitor?: { Plugins?: Native } }).Capacitor?.Plugins;

// Saving a file. A browser downloads it. The iPhone app's web view can't download anything (Capacitor has no
// download handling, so a download link does nothing), so there the file goes to the share sheet, which has Save
// to Files, AirDrop, Mail and the rest.
export async function saveFile(data: Blob, name: string) {
  const file = new File([data], name, { type: data.type || "application/octet-stream" });
  if (inApp()) {
    const { Filesystem, Share } = native() ?? {};
    // the app's own share sheet (app 1.2+): no tap needed to open it, so a slow fetch or export can't lose it
    if (Filesystem && Share) return shareNatively(file, Filesystem, Share);
    if (navigator.canShare?.({ files: [file] })) return share(file);
    // ponytail: an app build with neither can't save at all; the message beats a tap that does nothing
    return void toast.error("Update the Emplio app to save files.");
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

async function shareNatively(file: File, fs: NonNullable<Native["Filesystem"]>, sh: NonNullable<Native["Share"]>) {
  const data = await new Promise<string>((done, fail) => {
    const r = new FileReader();
    r.onload = () => done(String(r.result).slice(String(r.result).indexOf(",") + 1));
    r.onerror = () => fail(r.error);
    r.readAsDataURL(file);
  });
  // its own folder per save, so the share sheet shows the file's real name and two saves never clash
  const { uri } = await fs.writeFile({ path: `share/${Date.now()}/${file.name.replace(/[/\\:]/g, "_")}`, data, directory: "CACHE", recursive: true });
  // closing the sheet without picking anything rejects; that's not an error
  await sh.share({ files: [uri] }).catch((e: Error) => {
    if (!/cancel/i.test(e.message)) throw e;
  });
}

// Older app builds: the web's share sheet. iOS only opens it straight from a tap, and making the file can outlast
// that (a big export, a slow network), and then it's one more tap, on the toast.
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
