/**
 * Cloudflare Worker for Corsweb-proxy. 
 * 1. Serves the mock Nginx welcome page at the root path (/).
 * 2. Implements direct path proxying (e.g. /http://example.org or /example.org) to bypass CORS and Mixed Content.
 * 3. Rewrites .m3u8 playlists so all chunk URLs route through the proxy over HTTPS.
 * 4. Automatically maps raw IPv4 addresses to <ip>.sslip.io to prevent Cloudflare Error 1003.
 */

async function nginx() {
  const text = `
  <!DOCTYPE html>
  <html>
  <head>
  <title>Welcome to nginx!</title>
  <style>
    body {
      width: 35em;
      margin: 0 auto;
      font-family: Tahoma, Verdana, Arial, sans-serif;
    }
  </style>
  </head>
  <body>
  <h1>Welcome to nginx!</h1>
  <p>If you see this page, the nginx web server is successfully installed and
  working. Further configuration is required.</p>
  
  <p>For online documentation and support please refer to
  <a href="http://nginx.org/">nginx.org</a>.<br/>
  Commercial support is available at
  <a href="http://nginx.com/">nginx.com</a>.</p>
  
  <p><em>Thank you for using nginx.</em></p>
  </body>
  </html>
  `;
  return text;
}

function sanitizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    // If hostname is raw IPv4, convert to <ip>.sslip.io to bypass Cloudflare Error 1003
    if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) {
      u.hostname = `${u.hostname}.sslip.io`;
    }
    return u.href;
  } catch (_) {
    return rawUrl;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── 1. Handle Root Path with Nginx Page ────────────────────────────
    if (url.pathname === '/' || url.pathname === '') {
      const htmlContent = await nginx();
      return new Response(htmlContent, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // ── 2. Handle CORS Preflight (OPTIONS) ─────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // ── 3. Extract Target URL from Path ────────────────────────────────
    let rawTarget = url.pathname.slice(1); // Remove leading slash

    if (!rawTarget) {
      const htmlContent = await nginx();
      return new Response(htmlContent, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (url.search) {
      rawTarget += url.search;
    }

    // If protocol is omitted (e.g., example.org), default to http://
    if (!rawTarget.startsWith('http://') && !rawTarget.startsWith('https://')) {
      rawTarget = 'http://' + rawTarget;
    }

    const targetUrl = sanitizeUrl(rawTarget);

    try {
      const fetchHeaders = new Headers();
      if (request.headers.has('range')) {
        fetchHeaders.set('range', request.headers.get('range'));
      }
      if (request.headers.has('accept')) {
        fetchHeaders.set('accept', request.headers.get('accept'));
      }
      fetchHeaders.set(
        'User-Agent',
        request.headers.get('user-agent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      );

      const resp = await fetch(targetUrl, {
        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: fetchHeaders,
        redirect: 'follow',
      });

      // Copy and sanitize response headers
      const outHeaders = new Headers();
      for (const [key, val] of resp.headers.entries()) {
        const lKey = key.toLowerCase();
        if (
          lKey === 'content-security-policy' ||
          lKey === 'x-frame-options' ||
          lKey === 'access-control-allow-origin' ||
          lKey === 'access-control-allow-headers' ||
          lKey === 'access-control-allow-methods'
        ) {
          continue;
        }
        outHeaders.set(key, val);
      }

      outHeaders.set('Access-Control-Allow-Origin', '*');
      outHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
      outHeaders.set('Access-Control-Allow-Headers', '*');
      outHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type');

      const contentType = resp.headers.get('content-type') || '';
      const isM3U8 =
        targetUrl.includes('.m3u') ||
        contentType.includes('mpegurl') ||
        contentType.includes('x-mpegurl');

      // For M3U8 playlists: rewrite stream/segment URLs through the proxy root path
      if (isM3U8 && resp.ok) {
        const text = await resp.text();
        if (text.includes('#EXTM3U')) {
          const proxyBase = `${url.origin}/`;
          const lines = text.split('\n');

          const resolveUrl = raw => {
            try {
              const resolved = new URL(raw, targetUrl).href;
              return sanitizeUrl(resolved);
            } catch (_) {
              return raw;
            }
          };

          const rewritten = lines.map(line => {
            const trimmed = line.trim();
            if (!trimmed) return line;

            if (trimmed.startsWith('#')) {
              return line.replace(/URI="([^"]+)"/g, (match, uri) => {
                const fullUri = resolveUrl(uri);
                return `URI="${proxyBase}${fullUri}"`;
              });
            }

            const fullUrl = resolveUrl(trimmed);
            return `${proxyBase}${fullUrl}`;
          }).join('\n');

          outHeaders.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
          outHeaders.delete('Content-Length');
          return new Response(rewritten, {
            status: resp.status,
            statusText: resp.statusText,
            headers: outHeaders,
          });
        } else {
          return new Response(text, {
            status: resp.status,
            statusText: resp.statusText,
            headers: outHeaders,
          });
        }
      }

      // For TS video chunks, ensure proper video/mp2t MIME type
      if (targetUrl.includes('.ts') && (!outHeaders.has('content-type') || outHeaders.get('content-type').includes('text'))) {
        outHeaders.set('Content-Type', 'video/mp2t');
      }

      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: outHeaders,
      });

    } catch (err) {
      return new Response(`Proxy error: ${err.message}`, {
        status: 502,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'text/plain; charset=utf-8',
        },
      });
    }
  },
};
