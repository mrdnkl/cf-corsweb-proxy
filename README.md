# cf-corsweb-proxy

A Cloudflare Worker that fetches a URL supplied in the request path and adds permissive CORS response headers. It can also rewrite HLS (`.m3u8`) playlist URLs so playlist resources are requested through the Worker.

> **Security warning:** This Worker currently has no authentication or target-host allowlist. Anyone who can reach a public deployment can use it to make requests to arbitrary URLs, and responses are shared with permissive CORS headers. Do not deploy it as an unrestricted public proxy unless that is intentional. Restrict access and/or add an allowlist before production use.

## Features

- Serves a simple Nginx-style welcome page at `/` (this is a static mock page, not an Nginx server).
- Proxies target URLs supplied in the request path; URLs without a scheme default to `http://`.
- Adds CORS headers to proxied responses and answers `OPTIONS` preflight requests.
- Rewrites absolute and relative URLs in HLS playlists, including `URI="..."` attributes, to route them through the Worker.
- Rewrites raw IPv4 target hosts to the corresponding `sslip.io` hostname.

## Usage

Replace `<worker-domain>` with your deployed Worker hostname. Put the complete destination URL immediately after the first `/`:

```text
https://<worker-domain>/https://example.com/path
```

For example, fetch a web page with `curl`:

```bash
curl "https://<worker-domain>/https://example.com/"
```

A target URL's query string can be included as part of the proxied URL:

```text
https://<worker-domain>/https://example.com/search?q=cloudflare
```

HLS playlists can be requested the same way:

```text
https://<worker-domain>/https://example.com/playlist.m3u8
```

When a valid M3U8 playlist is returned, its resource URLs are rewritten to use the Worker. Requests to the proxy root (`/`) return the welcome page.

### Supported methods

The Worker handles `GET` and `HEAD` requests to the target. `OPTIONS` is answered locally as a CORS preflight request. Although the response CORS headers list `POST`, the current implementation does not forward POST request bodies or proxy POST requests.

## Deploy to Cloudflare Workers

The repository includes a `wrangler.toml` configuration that points Wrangler to `_worker.js`.

1. Install Node.js and npm if needed.
2. Install Wrangler and authenticate with Cloudflare:

   ```bash
   npm install --global wrangler
   wrangler login
   ```

3. From the repository directory, run locally:

   ```bash
   wrangler dev
   ```

4. Deploy the Worker:

   ```bash
   wrangler deploy
   ```

Wrangler will provide the deployed Worker URL. Follow Cloudflare's documentation to attach a custom domain or route if desired.

## Configuration and implementation

- ` _worker.js` — Cloudflare Worker request handler and proxy logic.
- `wrangler.toml` — Wrangler project configuration.

The Worker forwards the incoming `Accept` and `Range` headers (and sets a User-Agent), follows redirects, and removes selected response headers before adding CORS headers. It does not forward arbitrary request headers or POST bodies.

## Security and operational notes

- Add authentication, rate limiting, and a strict destination-host allowlist before making this available to untrusted users. A public unrestricted proxy can be abused and may incur Cloudflare usage or bandwidth costs.
- Review Cloudflare's acceptable-use requirements and your own deployment's security and privacy needs.
- This project does not guarantee that a destination is safe, available, or compatible with the proxy.

## License

This project is distributed under the GNU General Public License v3.0. See [LICENSE](LICENSE) for the full text.
