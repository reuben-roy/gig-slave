import { createHash, randomBytes, randomInt } from "node:crypto";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function newCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

export const displayCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
export const normalizeCode = (input: string) => input.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
export const newToken = () => randomBytes(32).toString("hex");
export const newId = () => randomBytes(8).toString("hex");
