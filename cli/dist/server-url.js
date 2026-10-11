export const BAKED_SERVER_URL = "https://gig-slave.reubenroyk.workers.dev";
export function resolveServerUrl() {
    const url = process.env.GIG_SLAVE_SERVER?.trim() || BAKED_SERVER_URL;
    return url.replace(/\/+$/, "");
}
