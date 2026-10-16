export const BAKED_SERVER_URL = "https://gigagent-beta.vercel.app";
export function resolveServerUrl() {
    const url = process.env.GIGAGENT_SERVER?.trim() || process.env.GIG_SLAVE_SERVER?.trim() || BAKED_SERVER_URL;
    return url.replace(/\/+$/, "");
}
