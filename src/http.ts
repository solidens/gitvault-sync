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
