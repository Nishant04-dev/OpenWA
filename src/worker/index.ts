export interface Env {
  ASSETS: {
    fetch: (request: Request | string) => Promise<Response>;
  };
  OPENWA_BACKEND_URL?: string;
  NODE_ENV?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Handle CORS preflight for API routes
    if (request.method === 'OPTIONS' && pathname.startsWith('/api/')) {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Handle /api/* requests
    if (pathname.startsWith('/api/')) {
      // If a backend URL is configured (e.g. self-hosted OpenWA instance), proxy the request
      if (env.OPENWA_BACKEND_URL) {
        const targetUrl = new URL(pathname + url.search, env.OPENWA_BACKEND_URL);
        const modifiedHeaders = new Headers(request.headers);
        modifiedHeaders.set('X-Forwarded-Host', url.host);
        modifiedHeaders.set('X-Forwarded-Proto', url.protocol.replace(':', ''));

        const init: RequestInit = {
          method: request.method,
          headers: modifiedHeaders,
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.blob(),
          redirect: 'manual',
        };

        try {
          const response = await fetch(targetUrl.toString(), init);
          const responseHeaders = new Headers(response.headers);
          responseHeaders.set('Access-Control-Allow-Origin', '*');
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
          });
        } catch (error) {
          return new Response(
            JSON.stringify({
              statusCode: 502,
              error: 'Bad Gateway',
              message: `Failed to connect to backend upstream: ${(error as Error).message}`,
            }),
            {
              status: 502,
              headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            },
          );
        }
      }

      // Default built-in API health & info routes when no backend URL is set
      if (pathname === '/api/health' || pathname === '/api/health/live' || pathname === '/api/health/ready') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            service: 'OpenWA Cloudflare Gateway',
            timestamp: new Date().toISOString(),
            uptime: process.uptime ? process.uptime() : 0,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          },
        );
      }

      if (pathname === '/api/infra/status' || pathname === '/api/infra/health') {
        return new Response(
          JSON.stringify({
            status: 'ok',
            gateway: 'cloudflare-worker',
            version: '0.24.0',
            backendConfigured: false,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          },
        );
      }
    }

    // Serve static assets via Cloudflare Workers ASSETS binding
    try {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404) {
        return assetResponse;
      }

      // SPA Fallback: if asset not found and request does not have a file extension, serve index.html
      const isFileRequest = /\.[a-zA-Z0-9]+$/.test(pathname);
      if (!isFileRequest && env.ASSETS) {
        const indexRequest = new Request(new URL('/index.html', request.url).toString(), request);
        const indexResponse = await env.ASSETS.fetch(indexRequest);
        if (indexResponse.status === 200) {
          return indexResponse;
        }
      }

      return assetResponse;
    } catch (e) {
      return new Response('Internal Gateway Error', { status: 500 });
    }
  },
};
