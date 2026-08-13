export interface JsonRequestOptions {
  method?: string;
  body?: unknown;
  authorization?: string;
}

export interface JsonRequestParameters {
  url: string;
  method: string;
  headers: Record<string, string>;
  throw: false;
  body?: string;
}

export function buildJsonRequest(url: string, options: JsonRequestOptions = {}): JsonRequestParameters {
  const headers: Record<string, string> = {};
  if (options.authorization) headers.authorization = options.authorization;
  if (options.body === undefined) {
    return { url, method: options.method ?? "GET", headers, throw: false };
  }
  headers["content-type"] = "application/json";
  return {
    url,
    method: options.method ?? "GET",
    headers,
    throw: false,
    body: JSON.stringify(options.body)
  };
}

