// Stable front door: forwards every request (including streamed bodies and SSE) to the current tunnel.
export default {
  async fetch(request, env) {
    if (!env.TARGET) return new Response("gig-slave tunnel is not configured", { status: 503 });
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, env.TARGET);
    const headers = new Headers(request.headers);
    headers.set("x-gig-client-ip", request.headers.get("cf-connecting-ip") ?? "");
    try {
      return await fetch(new Request(target, { method: request.method, headers, body: request.body, redirect: "manual" }));
    } catch {
      return new Response("gig-slave server is offline", { status: 502 });
    }
  },
};
