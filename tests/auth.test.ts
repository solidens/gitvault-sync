import { expect, test } from "vitest";
import { AuthError, type Http, type HttpRequest } from "../src/http";
import { listInstallationRepos, pollDeviceToken, startDeviceFlow, type DeviceCode } from "../src/auth";

const res = (body: unknown, status = 200) => ({ status, headers: {}, text: JSON.stringify(body), arrayBuffer: new ArrayBuffer(0) });
const code: DeviceCode = { deviceCode: "dc", userCode: "UC", verificationUri: "https://github.com/login/device", interval: 5, expiresAt: 1_000_000 };

test("startDeviceFlow parses response", async () => {
  let req!: HttpRequest;
  const http: Http = async (r) => { req = r; return res({ device_code: "dc", user_code: "UC", verification_uri: "u", interval: 5, expires_in: 900 }); };
  const c = await startDeviceFlow(http, "cid", () => 1000);
  expect(c).toEqual({ deviceCode: "dc", userCode: "UC", verificationUri: "u", interval: 5, expiresAt: 1000 + 900_000 });
  expect(req.url).toBe("https://github.com/login/device/code");
  expect(req.headers?.Accept).toBe("application/json");
  expect(req.body).toContain("client_id=cid");
});

function seq(...bodies: object[]) {
  const sleeps: number[] = [];
  let i = 0;
  const http: Http = async () => res(bodies[i++]);
  return { http, sleeps, sleep: async (ms: number) => { sleeps.push(ms); } };
}

test("pending, pending, token", async () => {
  const s = seq({ error: "authorization_pending" }, { error: "authorization_pending" }, { access_token: "tok" });
  expect(await pollDeviceToken(s.http, "cid", code, s.sleep, () => 0)).toBe("tok");
  expect(s.sleeps).toEqual([5000, 5000, 5000]);
});

test("slow_down adds 5s", async () => {
  const s = seq({ error: "slow_down" }, { error: "authorization_pending" }, { access_token: "tok" });
  await pollDeviceToken(s.http, "cid", code, s.sleep, () => 0);
  expect(s.sleeps).toEqual([5000, 10000, 10000]);
});

test("access_denied and expired_token throw AuthError", async () => {
  for (const error of ["access_denied", "expired_token"]) {
    const s = seq({ error });
    await expect(pollDeviceToken(s.http, "cid", code, s.sleep, () => 0)).rejects.toBeInstanceOf(AuthError);
  }
});

test("local expiry throws AuthError", async () => {
  const s = seq({ error: "authorization_pending" });
  await expect(pollDeviceToken(s.http, "cid", code, s.sleep, () => 1_000_000)).rejects.toBeInstanceOf(AuthError);
});

test("listInstallationRepos collects from two installations", async () => {
  const http: Http = async (r) => {
    expect(r.headers?.Authorization).toBe("Bearer t");
    if (r.url.includes("/user/installations?")) return res({ total_count: 2, installations: [{ id: 1 }, { id: 2 }] });
    if (r.url.includes("/installations/1/")) return res({ total_count: 1, repositories: [{ name: "a", owner: { login: "me" } }] });
    return res({ total_count: 1, repositories: [{ name: "b", owner: { login: "org" } }] });
  };
  expect(await listInstallationRepos(http, "t")).toEqual([{ owner: "me", repo: "a" }, { owner: "org", repo: "b" }]);
});

test("listInstallationRepos 401 throws AuthError", async () => {
  await expect(listInstallationRepos(async () => res({}, 401), "t")).rejects.toBeInstanceOf(AuthError);
});
