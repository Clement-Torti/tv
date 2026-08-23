/*
 * Cloudflare Worker: HTTPS front for plain-HTTP streams.
 *
 * Why this exists
 * ---------------
 * The site is served over HTTPS. A browser refuses to load an http:// stream
 * from an HTTPS page: without `upgrade-insecure-requests` it is blocked outright
 * as mixed content, and with it the request is rewritten to https://, which the
 * bare-IP hosts these streams live on do not speak. Either way the stream cannot
 * be reached, even though it is perfectly alive. Roughly 1,800 channels in the
 * upstream lists are http-only, about half of them still broadcasting.
 *
 * This Worker is the HTTPS hop that makes them reachable. It is not a
 * circumvention tool: it forwards openly accessible streams and carries no
 * credentials, tokens or DRM handling.
 *
 * Why a manifest rewrite is required
 * ----------------------------------
 * Forwarding the playlist alone is not enough. An HLS manifest refers to
 * segments, audio tracks, subtitles and keys by relative or absolute URL; the
 * player resolves those against whatever host served the playlist, so they would
 * come back to this Worker as bare paths, or bypass it and hit http:// again.
 * Every URL inside a playlist is therefore rewritten to point back here.
 *
 * Deploy
 * ------
 *   npm install -g wrangler
 *   wrangler login
 *   wrangler deploy worker/stream-proxy.js --name tv-stream-proxy --compatibility-date 2024-01-01
 *
 * Then put the resulting URL in assets/js/config.js as STREAM_PROXY, keeping the
 * trailing `/?url=`.
 */

/*
 * Only these origins may use the Worker. Without this it is an open proxy that
 * anyone can point at anything, on your account's quota. Add your own origins.
 */
const ALLOWED_ORIGINS = [
    'https://clement-torti.github.io',
    'http://localhost:8000',
    'http://127.0.0.1:8000'
];

// Playlists get rewritten; everything else is streamed straight through.
const PLAYLIST_TYPES = /mpegurl|m3u8/i;

export default {
    async fetch(request) {
        const origin = request.headers.get('Origin');

        if (request.method === 'OPTIONS') return preflight(origin);
        if (request.method !== 'GET') return deny('Method not allowed', 405, origin);
        if (origin && !ALLOWED_ORIGINS.includes(origin)) return deny('Origin not allowed', 403, origin);

        const target = new URL(request.url).searchParams.get('url');
        if (!target) return deny('Missing ?url=', 400, origin);
        if (!/^https?:\/\//i.test(target)) return deny('Only http(s) targets', 400, origin);

        let upstream;
        try {
            upstream = await fetch(target, {
                headers: {
                    // These hosts commonly reject non-browser clients.
                    'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0',
                    'Accept': '*/*',
                    ...(request.headers.get('Range') ? { Range: request.headers.get('Range') } : {})
                },
                redirect: 'follow'
            });
        } catch (e) {
            return deny(`Upstream unreachable: ${e.message}`, 502, origin);
        }

        if (!upstream.ok && upstream.status !== 206) {
            return deny(`Upstream responded ${upstream.status}`, upstream.status, origin);
        }

        const contentType = upstream.headers.get('Content-Type') || '';
        const self = new URL(request.url);
        const proxyBase = `${self.origin}${self.pathname}?url=`;

        // A playlist is small, so reading it whole to rewrite it is cheap.
        // `upstream.url` is used as the base so redirects resolve correctly.
        if (PLAYLIST_TYPES.test(contentType) || /\.m3u8(\?|$)/i.test(target)) {
            const body = await upstream.text();
            if (body.trimStart().startsWith('#EXTM3U')) {
                return respond(rewritePlaylist(body, upstream.url || target, proxyBase),
                    'application/vnd.apple.mpegurl', origin, upstream.status);
            }
            return respond(body, contentType || 'text/plain', origin, upstream.status);
        }

        // Segments and keys are passed through as a stream: no buffering, so
        // memory stays flat regardless of segment size.
        return new Response(upstream.body, {
            status: upstream.status,
            headers: corsHeaders(origin, {
                'Content-Type': contentType || 'application/octet-stream',
                'Cache-Control': 'no-store'
            })
        });
    }
};

/* Points every URL a playlist references back through this Worker. */
function rewritePlaylist(text, baseUrl, proxyBase) {
    const wrap = (raw) => proxyBase + encodeURIComponent(new URL(raw, baseUrl).toString());

    return text.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed) return line;

        // Bare lines are media or variant playlist references.
        if (!trimmed.startsWith('#')) return wrap(trimmed);

        // Tag attributes carry the rest: keys, audio tracks, subtitles, I-frames.
        return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${wrap(uri)}"`);
    }).join('\n');
}

function corsHeaders(origin, extra = {}) {
    return {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
        ...extra
    };
}

function preflight(origin) {
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

function respond(body, contentType, origin, status = 200) {
    return new Response(body, {
        status,
        headers: corsHeaders(origin, { 'Content-Type': contentType, 'Cache-Control': 'no-store' })
    });
}

function deny(message, status, origin) {
    return new Response(message, { status, headers: corsHeaders(origin, { 'Content-Type': 'text/plain' }) });
}
