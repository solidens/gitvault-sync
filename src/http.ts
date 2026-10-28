import { requestUrl } from "obsidian";

export interface HttpRequest { url: string; method: string; headers?: Record<string, string>; body?: string | ArrayBuffer }
export interface HttpResponse { status: number; headers: Record<string, string>; text: string; arrayBuffer: ArrayBuffer }
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export class HttpError extends Error {
  constructor(public status: number, message = `HTTP ${status}`) { super(message); this.name = "HttpError"; }
}
export class RateLimitError extends Error {
  constructor(public resetAt: number, message = "GitHub rate limit") { super(message); this.name = "RateLimitError"; }
}
export class AuthError extends Error {
  constructor(message = "GitHub auth failed") { super(message); this.name = "AuthError"; }
}
export class ShaConflictError extends Error {
  constructor(public path?: string, message = "sha conflict") { super(message); this.name = "ShaConflictError"; }
}

export const obsidianHttp: Http = async (req) => {
  const r = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false });
  // lazy: decoding a tarball as text would waste memory, reading JSON as a buffer too
  return { status: r.status, headers: r.headers, get text() { return r.text; }, get arrayBuffer() { return r.arrayBuffer; } };
};

/** JSON.parse with the response's expected shape: the one place an external payload gets a type. */
export const parseJson = <T>(text: string): T => JSON.parse(text) as T;
