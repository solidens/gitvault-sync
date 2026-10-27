export async function gunzip(data: ArrayBuffer): Promise<ArrayBuffer> {
  if (typeof DecompressionStream === "undefined") throw Error("no DecompressionStream");
  return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

const td = new TextDecoder();
const str = (b: Uint8Array) => { const z = b.indexOf(0); return td.decode(z < 0 ? b : b.subarray(0, z)); };

/** Regular files only. shortcut: GNU ././@LongLink is not supported (GitHub emits pax), add if needed. */
export function parseTar(data: ArrayBuffer): Map<string, Uint8Array> {
  const buf = new Uint8Array(data), out = new Map<string, Uint8Array>();
  let paxPath: string | undefined;
  for (let p = 0; p + 512 <= buf.length; ) {
    const h = buf.subarray(p, p + 512);
    if (h.every((x) => x === 0)) break;
    const size = parseInt(str(h.subarray(124, 136)).trim(), 8);
    if (!Number.isFinite(size)) throw new Error("bad tar header");
    const type = h[156] === 0 ? "0" : String.fromCharCode(h[156]);
    const body = buf.subarray(p + 512, p + 512 + size);
    if (body.length < size) throw new Error("truncated tar");
    p += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      // records: "<len> key=value\n", len counts the whole record in bytes
      for (let i = 0; i < body.length; ) {
        const sp = body.indexOf(32, i), len = parseInt(td.decode(body.subarray(i, sp)), 10);
        if (!(len > 0)) throw new Error("bad pax record");
        const kv = td.decode(body.subarray(sp + 1, i + len - 1));
        if (kv.startsWith("path=")) paxPath = kv.slice(5);
        i += len;
      }
    } else if (type === "0") {
      const prefix = str(h.subarray(345, 500));
      const name = paxPath ?? (prefix ? prefix + "/" : "") + str(h.subarray(0, 100));
      out.set(name, body);
      paxPath = undefined;
    } else if (type !== "g") paxPath = undefined; // dirs etc.; 'g' is global and must not touch pending x
  }
  return out;
}
