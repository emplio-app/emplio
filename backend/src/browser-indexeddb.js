// Run in a page by browser.ts. Given { limit }, returns the site's Indexed DB as JSON; a database over the limit, or
// holding what JSON can't carry (a Blob, a locked CryptoKey), is left out whole, since half a database is worse than none.
// Given { dbs }, creates the ones this browser doesn't already have.
async function (job) {
  var toText = function (b) { var s = ""; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
  var toBytes = function (t) { return Uint8Array.from(atob(t), function (c) { return c.charCodeAt(0); }); };

  var pack = function (v) {
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    if (v === undefined) return { $idb: "none" };
    if (v instanceof Date) return { $idb: "date", v: v.getTime() };
    if (v instanceof ArrayBuffer) return { $idb: "buffer", v: toText(new Uint8Array(v)) };
    if (ArrayBuffer.isView(v)) return { $idb: v.constructor.name, v: toText(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    if (Array.isArray(v)) return v.map(pack);
    var proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new Error("can't be kept");
    var out = {};
    Object.keys(v).forEach(function (k) { out[k] = pack(v[k]); });
    return out;
  };
  var unpack = function (v) {
    if (Array.isArray(v)) return v.map(unpack);
    if (v === null || typeof v !== "object") return v;
    if (v.$idb === "none") return undefined;
    if (v.$idb === "date") return new Date(v.v);
    if (v.$idb === "buffer") return toBytes(v.v).buffer;
    if (v.$idb) return new self[v.$idb](toBytes(v.v).buffer);
    var out = {};
    Object.keys(v).forEach(function (k) { out[k] = unpack(v[k]); });
    return out;
  };

  var opened = function (r) {
    return new Promise(function (ok, no) {
      r.onsuccess = function () { ok(r.result); };
      r.onerror = function () { no(r.error); };
    });
  };
  var finished = function (tx) {
    return new Promise(function (ok, no) {
      tx.oncomplete = ok;
      tx.onabort = tx.onerror = function () { no(tx.error); };
    });
  };

  var dump = async function (db, limit) {
    var names = Array.from(db.objectStoreNames);
    var kept = { name: db.name, version: db.version, stores: [], size: 0 };
    if (!names.length) return kept;
    var tx = db.transaction(names, "readonly");
    var done = finished(tx);
    names.forEach(function (name) {
      var s = tx.objectStore(name);
      var rows = [];
      var indexes = Array.from(s.indexNames).map(function (n) {
        var i = s.index(n);
        return { name: i.name, keyPath: i.keyPath, unique: i.unique, multiEntry: i.multiEntry };
      });
      kept.stores.push({ name: name, keyPath: s.keyPath, autoIncrement: s.autoIncrement, indexes: indexes, rows: rows });
      s.openCursor().onsuccess = function (e) {
        var c = e.target.result;
        if (!c) return;
        try {
          var row = [pack(c.primaryKey), pack(c.value)];
          kept.size += JSON.stringify(row).length;
          if (kept.size > limit) throw new Error("too big");
          rows.push(row);
          c.continue();
        } catch (err) {
          tx.abort();
        }
      };
    });
    await done;
    return kept;
  };

  var have = await indexedDB.databases();
  if (job.limit !== undefined) {
    var dbs = [];
    var left = job.limit;
    for (var info of have) {
      var db = await opened(indexedDB.open(info.name)).catch(function () { return null; });
      if (!db) continue;
      var kept = await dump(db, left).catch(function () { return null; });
      db.close();
      if (kept) { left -= kept.size; delete kept.size; dbs.push(kept); }
    }
    return JSON.stringify(dbs);
  }

  var there = new Set(have.map(function (d) { return d.name; }));
  for (var d of job.dbs) {
    if (there.has(d.name)) continue;
    try {
      var r = indexedDB.open(d.name, d.version);
      r.onupgradeneeded = function () {
        var target = r.result;
        d.stores.forEach(function (s) {
          var store = target.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
          s.indexes.forEach(function (i) { store.createIndex(i.name, i.keyPath, { unique: i.unique, multiEntry: i.multiEntry }); });
        });
      };
      var made = await opened(r);
      if (d.stores.length) {
        var tx = made.transaction(d.stores.map(function (s) { return s.name; }), "readwrite");
        var done = finished(tx);
        d.stores.forEach(function (s) {
          var store = tx.objectStore(s.name);
          s.rows.forEach(function (row) {
            if (s.keyPath === null) store.put(unpack(row[1]), unpack(row[0]));
            else store.put(unpack(row[1]));
          });
        });
        await done;
      }
      made.close();
    } catch (err) {
      // a site that finds its database half there would trust it
      indexedDB.deleteDatabase(d.name);
    }
  }
}
