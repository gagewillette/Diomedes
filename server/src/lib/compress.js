import compression from 'compression';

/**
 * gzip for HTTP responses.
 *
 * The Node process is the edge — nothing terminates in front of it — so this
 * has to happen in-process rather than at a proxy. Document bodies are
 * prose-heavy JSON and compress well. The default 1KB threshold leaves small
 * replies alone so we don't spend CPU for nothing.
 *
 * Register this *after* `perfMiddleware`: both patch `res.write`, and whichever
 * registers last ends up the outer wrapper. Compression on the outside is what
 * makes `perf_samples.transfer_bytes` mean the bytes that actually went down
 * the socket rather than the bytes the route handed to `res.json`.
 *
 * If a reverse proxy is ever put in front, drop this and compress at the edge
 * instead of compressing twice.
 */
export const compressionMiddleware = compression({
  filter(req, res) {
    // SSE is a long-lived stream: buffering it to fill a compression window
    // delays delivery. `/api/events` already sends `Cache-Control: no-transform`,
    // which the default filter honours, but the stream is worth being explicit
    // about rather than leaving it resting on a header set elsewhere.
    const type = String(res.getHeader('Content-Type') || '');
    if (type.startsWith('text/event-stream')) return false;
    return compression.filter(req, res);
  },
});
