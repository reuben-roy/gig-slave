const TOKEN_ANY = /hg_op_[A-Za-z0-9_-]+/g;

/** Secrets loaded in this process (tokens read from env/file/keychain). Registered so every output can be scrubbed. */
const known = new Set<string>();
export const registerSecret = (s: string | undefined | null) => {
  if (s && s.length >= 8) known.add(s);
};
export const clearSecrets = () => known.clear();

export function scrub(text: string, extra: string[] = [], opts: { pattern?: boolean } = {}): string {
  let out = opts.pattern === false ? text : text.replace(TOKEN_ANY, "hg_op_[redacted]");
  for (const s of [...known, ...extra]) if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  return out;
}

/** Deep-scrub every string in a JSON-like value. */
export function scrubValue<T>(v: T, extra: string[] = [], opts: { pattern?: boolean } = {}): T {
  if (typeof v === "string") return scrub(v, extra, opts) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, extra, opts)) as unknown as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubValue(x, extra, opts)])) as T;
  }
  return v;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const BIDI = [[0x202a, 0x202e], [0x2066, 0x2069]].map(([a, b]) => String.fromCharCode(a) + "-" + String.fromCharCode(b)).join("");
const CONTROL = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f" + BIDI + "]", "g");

/** Remove terminal escape sequences and control characters (keeps \n and \t). For text authored on another computer. */
export const stripControl = (s: string) => s.replace(ANSI, "").replace(CONTROL, "");

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
