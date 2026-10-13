export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url);
    const targetUrl = url.searchParams.get("url");

    if (!targetUrl) {
      return new Response(JSON.stringify({ error: "Missing ?url= parameter" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // بررسی توکن امنیتی
    const authToken = url.searchParams.get("token");
    const expectedToken = env.AUTH_TOKEN;
    if (expectedToken && authToken !== expectedToken) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    try {
      const newRequest = new Request(targetUrl, {
        method: request.method,
        headers: request.headers,
        body: request.method !== "GET" && request.method !== "HEAD" ? request.body : null,
      });
      newRequest.headers.set("Origin", new URL(targetUrl).origin);

      const response = await fetch(newRequest);
      const newResponse = new Response(response.body, response);
      newResponse.headers.set("Access-Control-Allow-Origin", "*");
      newResponse.headers.append("Vary", "Origin");
      return newResponse;
    } catch (e) {
      return new Response(JSON.stringify({ error: "Fetch failed: " + e.message }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
  },
};
