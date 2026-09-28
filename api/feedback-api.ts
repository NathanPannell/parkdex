import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import worker from '../worker/index.js';

export const config = { api: { bodyParser: false } };

// The same standards-based handler runs in local tests and the deployed function.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const route = Array.isArray(req.query.path) ? req.query.path.join('/') : req.query.path;
  const appUrl = process.env.PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined);
  if (!appUrl) return res.status(503).json({ error: 'Parkdex is temporarily unavailable.' });
  const url = new URL(`/api/${route || 'health'}`, appUrl);
  for (const [key, value] of Object.entries(req.query)) {
    if (key === 'path' || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item);
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  // Vercel overwrites this header. Never trust client-supplied Cloudflare/IP headers.
  const trustedIp = req.headers['x-vercel-forwarded-for'];
  headers.set('cf-connecting-ip', typeof trustedIp === 'string' ? trustedIp.split(',')[0].trim() : 'unknown');
  try {
    let body: Buffer | undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Vercel exposes a parsed body; local Node adapters may provide the stream instead.
      if (req.body !== undefined) {
        body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
      } else {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > 3 * 1024 * 1024) return res.status(413).json({ error: 'That upload is too large. Try a smaller image.' });
          chunks.push(buffer);
        }
        body = Buffer.concat(chunks);
      }
      if (body.length > 3 * 1024 * 1024) return res.status(413).json({ error: 'That upload is too large. Try a smaller image.' });
    }
    const request = new Request(url, { method: req.method, headers, body: body?.length ? new Uint8Array(body).buffer : undefined });
    const response = await worker.fetch(request, { ...process.env, PUBLIC_APP_URL: appUrl } as never, { waitUntil } as never);
    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== 'set-cookie') res.setHeader(key, value);
    });
    // Session and CSRF cookies must remain separate headers. A comma-joined cookie
    // header can lose one cookie in browsers, especially when Expires is present.
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader('set-cookie', cookies);
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.status(503).json({ error: 'Parkdex is temporarily unavailable. Please try again.' });
  }
}
