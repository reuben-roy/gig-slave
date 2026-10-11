export const BAKED_SERVER_URL = "https://inflation-someone-expenditures-contracts.trycloudflare.com";

export function resolveServerUrl(): string {
  const url = process.env.GIG_SLAVE_SERVER?.trim() || BAKED_SERVER_URL;
  return url.replace(/\/+$/, "");
}
