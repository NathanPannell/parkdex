const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const CHANNEL_CACHE_CONTROL = "public, max-age=60, s-maxage=60";
const ALLOWED_METHODS = "GET, HEAD, OPTIONS";
const ALLOWED_HEADERS =
  "If-Match, If-Modified-Since, If-None-Match, If-Range, If-Unmodified-Since, Range";

function corsHeaders(headers = new Headers()) {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
  headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
  headers.set(
    "Access-Control-Expose-Headers",
    "Accept-Ranges, Cache-Control, Content-Length, Content-Range, ETag, Last-Modified, X-Content-Cache",
  );
  return headers;
}

function response(status, body = null, headers = new Headers()) {
  return new Response(body, { status, headers: corsHeaders(headers) });
}

function channelKeyFromPath(pathname) {
  const match = /^\/channels\/(staging|main)\/current\.json$/.exec(pathname);
  return match ? "channels/" + match[1] + "/current.json" : null;
}

function keyFromPath(pathname) {
  const channelKey = channelKeyFromPath(pathname);
  if (channelKey) return channelKey;
  if (pathname === "/") return null;

  const parts = pathname.slice(1).split("/");
  if (parts.some((part) => part === "")) return null;

  let decoded;
  try {
    decoded = parts.map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }

  if (
    decoded.some(
      (part) =>
        part === "." ||
        part === ".." ||
        part.includes("/") ||
        part.includes("\\") ||
        part.includes("\0"),
    )
  ) {
    return null;
  }

  if (
    decoded[0] !== "releases" ||
    !/^[a-f0-9]{64}$/.test(decoded[1] ?? "") ||
    decoded.length < 3
  ) {
    return null;
  }

  return decoded.join("/");
}

function cacheKeyFor(request, key) {
  const url = new URL(request.url);
  url.pathname = `/${key.split("/").map(encodeURIComponent).join("/")}`;
  url.search = "";
  url.hash = "";
  return new Request(url, { method: "GET" });
}

function etagFor(object) {
  if (object.httpEtag) return object.httpEtag;
  if (!object.etag) return null;
  return object.etag.startsWith('"') || object.etag.startsWith('W/"')
    ? object.etag
    : `"${object.etag}"`;
}

function parseEntityTags(value) {
  if (!value) return [];
  const tags = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '"') quoted = !quoted;
    if (value[i] === "," && !quoted) {
      tags.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  tags.push(value.slice(start).trim());
  return tags;
}

function weakTag(tag) {
  return tag.startsWith("W/") ? tag.slice(2) : tag;
}

function tagsMatch(value, etag, allowWeak) {
  if (!value || !etag) return false;
  return parseEntityTags(value).some((tag) => {
    if (tag === "*") return true;
    if (!/^(?:W\/)?"[^"]*"$/.test(tag)) return false;
    if (allowWeak) return weakTag(tag) === weakTag(etag);
    return !tag.startsWith("W/") && !etag.startsWith("W/") && tag === etag;
  });
}

function dateHeader(headers, name) {
  const value = headers.get(name);
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function conditionalStatus(headers, etag, uploaded, method) {
  const modified = uploaded instanceof Date ? uploaded.getTime() : NaN;
  const ifMatch = headers.get("If-Match");
  if (ifMatch && !tagsMatch(ifMatch, etag, false)) return 412;

  const unmodifiedSince = dateHeader(headers, "If-Unmodified-Since");
  if (
    !ifMatch &&
    unmodifiedSince !== null &&
    Number.isFinite(modified) &&
    Math.floor(modified / 1000) * 1000 > unmodifiedSince
  ) {
    return 412;
  }

  const ifNoneMatch = headers.get("If-None-Match");
  if (ifNoneMatch) {
    return tagsMatch(ifNoneMatch, etag, true)
      ? method === "GET" || method === "HEAD"
        ? 304
        : 412
      : null;
  }

  const modifiedSince = dateHeader(headers, "If-Modified-Since");
  if (
    modifiedSince !== null &&
    Number.isFinite(modified) &&
    Math.floor(modified / 1000) * 1000 <= modifiedSince
  ) {
    return method === "GET" || method === "HEAD" ? 304 : null;
  }

  return null;
}

function rangeForRequest(headers, etag, uploaded) {
  const value = headers.get("Range");
  if (!value || value.includes(",")) return null;

  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;

  let range;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    range = { suffix };
  } else {
    const offset = Number(match[1]);
    const end = match[2] ? Number(match[2]) : null;
    if (
      !Number.isSafeInteger(offset) ||
      (end !== null && (!Number.isSafeInteger(end) || end < offset))
    ) {
      return null;
    }
    range = { offset, ...(end === null ? {} : { length: end - offset + 1 }) };
  }

  const ifRange = headers.get("If-Range");
  if (ifRange) {
    const parsedDate = Date.parse(ifRange);
    const matchesTag = ifRange.startsWith('"') && etag && ifRange === etag;
    const matchesDate =
      !Number.isNaN(parsedDate) &&
      uploaded instanceof Date &&
      Math.floor(uploaded.getTime() / 1000) * 1000 <= parsedDate;
    if (!matchesTag && !matchesDate) return null;
  }

  return range;
}

function resolvedRange(range, size) {
  if (!range || size <= 0) return null;
  if (range.suffix !== undefined) {
    const start = Math.max(0, size - range.suffix);
    return { start, end: size - 1 };
  }
  if (range.offset >= size) return null;
  const end = Math.min(
    size - 1,
    range.length === undefined ? size - 1 : range.offset + range.length - 1,
  );
  return { start: range.offset, end };
}

function metadataHeaders(object, cacheControl = null) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const etag = etagFor(object);
  if (etag) headers.set("ETag", etag);
  if (object.uploaded instanceof Date) {
    headers.set("Last-Modified", object.uploaded.toUTCString());
  }
  if (cacheControl) {
    headers.set("Cache-Control", cacheControl);
    headers.set("Content-Type", "application/json; charset=utf-8");
  } else if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", IMMUTABLE_CACHE_CONTROL);
  }
  headers.set("Accept-Ranges", "bytes");
  return headers;
}

function conditionResponse(status, headers, cacheStatus) {
  const resultHeaders = new Headers(headers);
  resultHeaders.delete("Content-Length");
  if (cacheStatus) resultHeaders.set("X-Content-Cache", cacheStatus);
  return response(status, null, resultHeaders);
}

function withCacheStatus(cached, cacheStatus) {
  const headers = new Headers(cached.headers);
  headers.set("X-Content-Cache", cacheStatus);
  return response(cached.status, cached.body, headers);
}

function isInvalidRangeError(error) {
  return /\(10039\)\s*$/.test(String(error?.message ?? error));
}

function rangeNotSatisfiable(size, cacheStatus = "BYPASS") {
  const headers = new Headers({
    "Content-Range": `bytes */${size}`,
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Cache": cacheStatus,
  });
  return response(416, "Range Not Satisfiable", headers);
}

async function fetchContent(request, env, ctx) {
  const url = new URL(request.url);
  const channelKey = channelKeyFromPath(url.pathname);
  if (
    channelKey &&
    request.method !== "GET" &&
    request.method !== "HEAD"
  ) {
    return response(405, "Method Not Allowed", new Headers({ Allow: "GET, HEAD" }));
  }

  if (request.method === "OPTIONS") {
    return response(204, null, new Headers({ "Access-Control-Max-Age": "86400" }));
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return response(405, "Method Not Allowed", new Headers({ Allow: ALLOWED_METHODS }));
  }

  const key = channelKey ?? keyFromPath(url.pathname);
  if (!key) return response(404, "Not Found", new Headers({ "Content-Type": "text/plain; charset=utf-8" }));

  const channelPointer = channelKey !== null;
  const cacheControl = channelPointer ? CHANNEL_CACHE_CONTROL : null;
  const isGet = request.method === "GET";
  const hasRange = isGet && request.headers.has("Range");
  let cacheStatus = "BYPASS";
  let cacheKey;

  if (isGet && !hasRange) {
    cacheKey = cacheKeyFor(request, key);
    try {
      const cached = await caches.default.match(cacheKey);
      if (cached) {
        const status = conditionalStatus(
          request.headers,
          cached.headers.get("ETag"),
          cached.headers.has("Last-Modified")
            ? new Date(cached.headers.get("Last-Modified"))
            : null,
          request.method,
        );
        if (status) return conditionResponse(status, cached.headers, "HIT");
        return withCacheStatus(cached, "HIT");
      }
      cacheStatus = "MISS";
    } catch {
      cacheStatus = "MISS";
    }
  }

  let object;
  if (!isGet) {
    object = await env.CONTENT.head(key);
    if (!object) return response(404, "Not Found", new Headers({ "Content-Type": "text/plain; charset=utf-8" }));

    const headers = metadataHeaders(object, cacheControl);
    const status = conditionalStatus(request.headers, etagFor(object), object.uploaded, request.method);
    if (status) return conditionResponse(status, headers, "BYPASS");
    headers.set("Content-Length", String(object.size));
    headers.set("X-Content-Cache", "BYPASS");
    return response(200, null, headers);
  }

  let requestedRange = null;
  if (hasRange) {
    let rangeMetadata = null;
    if (request.headers.has("If-Range")) {
      rangeMetadata = await env.CONTENT.head(key);
      if (!rangeMetadata) {
        return response(404, "Not Found", new Headers({ "Content-Type": "text/plain; charset=utf-8" }));
      }
    }
    requestedRange = rangeForRequest(
      request.headers,
      rangeMetadata ? etagFor(rangeMetadata) : null,
      rangeMetadata?.uploaded ?? null,
    );
  }

  const onlyIf = new Headers(request.headers);
  onlyIf.delete("Range");
  onlyIf.delete("If-Range");
  const options = { onlyIf };
  if (requestedRange) options.range = requestedRange;

  try {
    object = await env.CONTENT.get(key, options);
  } catch (error) {
    if (requestedRange && isInvalidRangeError(error)) {
      const head = await env.CONTENT.head(key);
      return head ? rangeNotSatisfiable(head.size) : response(404, "Not Found");
    }
    throw error;
  }

  if (!object) return response(404, "Not Found", new Headers({ "Content-Type": "text/plain; charset=utf-8" }));

  const headers = metadataHeaders(object, cacheControl);
  if (object.body === undefined) {
    const status = conditionalStatus(request.headers, etagFor(object), object.uploaded, request.method) ?? 412;
    return conditionResponse(status, headers, cacheStatus);
  }

  const selectedRange = requestedRange ? resolvedRange(requestedRange, object.size) : null;
  if (requestedRange && !selectedRange) return rangeNotSatisfiable(object.size);

  let status = 200;
  if (selectedRange) {
    status = 206;
    headers.set("Content-Range", `bytes ${selectedRange.start}-${selectedRange.end}/${object.size}`);
    headers.set("Content-Length", String(selectedRange.end - selectedRange.start + 1));
  } else {
    headers.set("Content-Length", String(object.size));
  }

  const result = response(status, object.body, headers);
  if (status === 200 && cacheKey && cacheStatus === "MISS") {
    ctx.waitUntil(caches.default.put(cacheKey, result.clone()).catch(() => {}));
  }
  return withCacheStatus(result, cacheStatus);
}

export default {
  fetch: fetchContent,
};

export { fetchContent };
