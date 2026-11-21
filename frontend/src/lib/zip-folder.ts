// A picked folder as one .zip, so its sub-folders and file names reach Emplio's computer as they were (a chat
// takes 10 files at most, and each lands flat in /work/in). Stored, not compressed: the browser has no deflate
// writer we can read the size of up front, and the upload cap keeps it small anyway.
// ponytail: no ZIP64, fine under the 100 MB upload cap; zip dates are left at 1980

// never worth sending: system clutter and the heavy folders a code project carries
const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|node_modules|\.git)(\/|$)/;

const CRC = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let c = ~0;
  for (const b of bytes) c = CRC[(c ^ b) & 255]! ^ (c >>> 8);
  return ~c >>> 0;
};

// null when what's left of the folder is over `max` bytes (nothing is read then) or empty
// each file with its path inside the folder ("Photos/2024/a.jpg"): webkitRelativePath when picked, the entry's path when dropped
export async function zipFolder(picked: { file: File; path: string }[], max: number): Promise<File | null> {
  const files = picked.filter((f) => !JUNK.test(f.path));
  if (!files.length || files.reduce((s, f) => s + f.file.size, 0) > max) return null;
  const enc = new TextEncoder();
  const body: BlobPart[] = [];
  const dir: BlobPart[] = [];
  let at = 0;
  let dirSize = 0;
  for (const f of files) {
    const name = enc.encode(f.path);
    const data = new Uint8Array(await f.file.arrayBuffer());
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x800, true); // names are UTF-8
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x800, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, at, true);
    body.push(local, name, data);
    dir.push(entry, name);
    at += 30 + name.length + data.length;
    dirSize += 46 + name.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, at, true);
  const root = files[0]!.path.split("/")[0] || "folder";
  return new File([...body, ...dir, end], `${root}.zip`, { type: "application/zip" });
}

// a folder dragged in: every file under it with its path, skipping junk folders before walking into them
export async function readDropped(entry: FileSystemEntry, out: { file: File; path: string }[] = []) {
  if (JUNK.test(entry.fullPath)) return out;
  if (entry.isFile) {
    const file = await new Promise<File>((ok, fail) => (entry as FileSystemFileEntry).file(ok, fail));
    out.push({ file, path: entry.fullPath.replace(/^\//, "") });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries hands them over in batches until an empty one
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
      if (!batch.length) break;
      for (const e of batch) await readDropped(e, out);
    }
  }
  return out;
}
