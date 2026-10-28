import { AuthError, HttpError, parseJson, type Http } from "./http";

type OAuthReply = { error?: string; error_description?: string; access_token?: string; device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number };

export interface DeviceCode { deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresAt: number }

export const GITHUB_CLIENT_ID = "Iv23liy5F3TWJKmuCvnj";

const jsonHeaders = { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" };
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

export async function startDeviceFlow(http: Http, clientId: string, now: () => number): Promise<DeviceCode> {
  const r = await http({ url: "https://github.com/login/device/code", method: "POST", headers: jsonHeaders, body: form({ client_id: clientId }) });
  const j = parseJson<OAuthReply>(r.text);
  if (r.status !== 200 || j.error) throw new AuthError(j.error_description ?? j.error ?? `HTTP ${r.status}`);
  return { deviceCode: j.device_code, userCode: j.user_code, verificationUri: j.verification_uri, interval: j.interval, expiresAt: now() + j.expires_in * 1000 };
}

export async function pollDeviceToken(http: Http, clientId: string, code: DeviceCode, sleep: (ms: number) => Promise<void>, now: () => number): Promise<string> {
  let interval = code.interval;
  while (now() < code.expiresAt) {
    await sleep(interval * 1000);
    const r = await http({
      url: "https://github.com/login/oauth/access_token", method: "POST", headers: jsonHeaders,
      body: form({ client_id: clientId, device_code: code.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    const j = parseJson<OAuthReply>(r.text);
    if (j.access_token) return j.access_token;
    if (j.error === "slow_down") interval += 5;
    else if (j.error !== "authorization_pending") throw new AuthError(j.error ?? `HTTP ${r.status}`);
  }
  throw new AuthError("Device code expired");
}

async function getJson<T>(http: Http, token: string, url: string): Promise<T> {
  const r = await http({ url, method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
  if (r.status === 401) throw new AuthError();
  if (r.status !== 200) throw new HttpError(r.status);
  return parseJson<T>(r.text);
}

// shortcut: first 100 installations/repos per installation only, upgrade if anyone exceeds that
export async function listInstallationRepos(http: Http, token: string): Promise<{ owner: string; repo: string }[]> {
  const out: { owner: string; repo: string }[] = [];
  const inst = await getJson<{ installations: { id: number }[] }>(http, token, "https://api.github.com/user/installations?per_page=100");
  for (const i of inst.installations) {
    const rs = await getJson<{ repositories: { name: string; owner: { login: string } }[] }>(http, token, `https://api.github.com/user/installations/${i.id}/repositories?per_page=100`);
    for (const r of rs.repositories) out.push({ owner: r.owner.login, repo: r.name });
  }
  return out;
}
