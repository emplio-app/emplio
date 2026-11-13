// Windows has no sandbox-exec, so Emplio's commands are fenced in the way Chrome fences its tabs: they run at Low
// integrity. A program started from a file labelled Low runs at Low, and so does everything it starts. A Low program
// can write only to what is labelled Low (each business's folder), and can't read what is labelled No-Read-Up (the
// person's keys, browser data and personal folders, and this app's own data). No admin rights: anyone may label their
// own files at or below their own level.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./tools.js";

// The same as the Mac's hidden list (box.js), in Windows' places
export function hiddenOnWindows(home = homedir(), env = process.env) {
  const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  const roaming = env.APPDATA ?? join(home, "AppData", "Roaming");
  return [
    ...[".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config", ".azure", ".netrc", ".npmrc", ".git-credentials", ".bash_history", ".gitconfig"].map((f) => join(home, f)),
    ...["Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music", "OneDrive"].map((f) => join(home, f)),
    ...[["Google", "Chrome", "User Data"], ["Microsoft", "Edge", "User Data"], ["BraveSoftware"], ["Microsoft", "Credentials"]].map((p) => join(local, ...p)),
    ...[["Mozilla"], ["Microsoft", "Credentials"], ["Microsoft", "Protect"], ["GitHub CLI"]].map((p) => join(roaming, ...p)),
  ];
}

// The label each path gets, as a security descriptor: Low for what commands may write (and inherit it), Medium with
// No-Read-Up for what they may not see
export const LOW_TREE = "S:(ML;OICI;NW;;;LW)";
export const LOW_FILE = "S:(ML;;NW;;;LW)";
export const HIDDEN = "S:(ML;OICI;NRNW;;;ME)";

const quoted = (s) => `'${String(s).replace(/'/g, "''")}'`;
// PowerShell, through Windows' own SetNamedSecurityInfo (icacls sets Low, but has no way to say No-Read-Up)
export function labelScript(pairs) {
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class EmplioLabel {
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string s, uint rev, out IntPtr sd, IntPtr size);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetSecurityDescriptorSacl(IntPtr sd, out bool present, out IntPtr sacl, out bool defaulted);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern uint SetNamedSecurityInfoW(string name, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  public static uint Set(string path, string sddl) {
    IntPtr sd, sacl; bool present, defaulted;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, IntPtr.Zero)) return (uint)Marshal.GetLastWin32Error();
    GetSecurityDescriptorSacl(sd, out present, out sacl, out defaulted);
    return SetNamedSecurityInfoW(path, 1, 0x10, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
  }
}
"@
${pairs.map(([path, sddl]) => `$r = [EmplioLabel]::Set(${quoted(path)}, ${quoted(sddl)}); if ($r) { Write-Output ("failed " + $r + ": " + ${quoted(path)}) }`).join("\n")}`;
}

// Labels these [path, label] pairs (paths that don't exist are skipped); throws on the first refusal
export async function label(pairs) {
  const there = pairs.filter(([p]) => existsSync(p));
  if (!there.length) return;
  const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const out = await run(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(labelScript(there), "utf16le").toString("base64")], { timeout: 600_000 });
  if (out.includes("failed ")) throw new Error(out.trim());
}

// Proof the fence holds, from inside it: the command runs at Low, can write its own folder, and can't write outside
// it or read what's hidden. Only then does this computer take Emplio's work (main.js says so to the server).
export function fenceTest(secret, outside) {
  return `MSYS_NO_PATHCONV=1 /c/Windows/System32/whoami.exe /groups | grep -q 'Low Mandatory Level' && echo LOW
echo x > "$HOME/.fence-test" && echo WROTE && rm -f "$HOME/.fence-test"
(echo x > ${JSON.stringify(outside)}) 2>/dev/null && echo ESCAPED && rm -f ${JSON.stringify(outside)}
cat ${JSON.stringify(secret)} >/dev/null 2>&1 && echo LEAKED
exit 0`;
}
export const fenceHolds = (out) => /LOW/.test(out) && /WROTE/.test(out) && !/ESCAPED|LEAKED/.test(out);
