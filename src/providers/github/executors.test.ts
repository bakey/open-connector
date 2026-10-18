import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearGitHubInstallationTokenCache } from "./app-installation.ts";
import { credentialValidators, executors } from "./executors.ts";

const appId = "5360099";
const installationId = "172567438";
const installationToken = "ghs_installation_token";

let privateKey: string;
let installationContext: ExecutionContext;
let apiKeyContext: ExecutionContext;

beforeAll(() => {
  privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString();
  const installation: ResolvedCredential = {
    authType: "custom_credential",
    values: { appId, installationId, privateKey },
    profile: { accountId: "bakey", displayName: "GitHub App installation on bakey", grantedScopes: [] },
    metadata: {},
  };
  installationContext = { getCredential: async () => installation };
  const apiKey: ResolvedCredential = {
    authType: "api_key",
    apiKey: "github_pat_secret",
    values: { apiKey: "github_pat_secret" },
    profile: { accountId: "bakey", displayName: "bakey", grantedScopes: [] },
    metadata: {},
  };
  apiKeyContext = { getCredential: async () => apiKey };
});

beforeEach(() => {
  clearGitHubInstallationTokenCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Record every outgoing request and answer each one from the given queue. */
function stubFetch(responses: Array<() => Response>): Request[] {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(input instanceof Request ? input : new Request(input, init));
    const next = responses[requests.length - 1];
    if (!next) {
      throw new Error(`unexpected request ${requests.length}: ${requests[requests.length - 1]!.url}`);
    }
    return next();
  });
  return requests;
}

function mintResponse(): Response {
  return Response.json(
    {
      token: installationToken,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      permissions: { issues: "read", metadata: "read", pull_requests: "read" },
      repository_selection: "selected",
    },
    { status: 201 },
  );
}

function installationResponse(): Response {
  return Response.json({
    id: Number(installationId),
    account: {
      login: "bakey",
      id: 1566848,
      type: "User",
      avatar_url: "https://avatars.githubusercontent.com/u/1566848",
      html_url: "https://github.com/bakey",
    },
    repository_selection: "selected",
    permissions: { issues: "read", metadata: "read", pull_requests: "read" },
  });
}

function isAppJwt(authorization: string | null): boolean {
  return authorization?.startsWith("Bearer ") === true && authorization.slice("Bearer ".length).split(".").length === 3;
}

describe("GitHub App installation credential", () => {
  it("mints an installation token once and sends it as the bearer on repository actions", async () => {
    const requests = stubFetch([
      () => mintResponse(),
      () => Response.json([{ id: 1566848, login: "bakey", permissions: { pull: true, push: true } }]),
      () => Response.json([]),
    ]);

    const first = await executors["github.list_repository_collaborators"]!(
      { owner: "bakey", repo: "Kairos", affiliation: "all" },
      installationContext,
    );
    const second = await executors["github.list_pull_requests"]!(
      { owner: "bakey", repo: "Kairos" },
      installationContext,
    );

    expect(first).toMatchObject({ ok: true, output: { collaborators: [{ login: "bakey" }] } });
    expect(second).toMatchObject({ ok: true, output: { pull_requests: [] } });
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      `POST /app/installations/${installationId}/access_tokens`,
      "GET /repos/bakey/Kairos/collaborators",
      "GET /repos/bakey/Kairos/pulls",
    ]);
    expect(isAppJwt(requests[0]!.headers.get("authorization"))).toBe(true);
    expect(requests[1]!.headers.get("authorization")).toBe(`Bearer ${installationToken}`);
    expect(requests[2]!.headers.get("authorization")).toBe(`Bearer ${installationToken}`);
    expect(new URL(requests[1]!.url).searchParams.get("affiliation")).toBe("all");
  });

  it("answers get_current_user from the installation's account, authenticated as the App", async () => {
    const requests = stubFetch([() => mintResponse(), () => installationResponse()]);

    const result = await executors["github.get_current_user"]!({}, installationContext);

    expect(result).toMatchObject({
      ok: true,
      output: {
        login: "bakey",
        id: 1566848,
        type: "User",
        name: null,
        email: null,
        installation: { id: Number(installationId), repository_selection: "selected" },
      },
    });
    expect(new URL(requests[1]!.url).pathname).toBe(`/app/installations/${installationId}`);
    // The installation detail is an App endpoint: it takes the JWT, not the installation token.
    expect(isAppJwt(requests[1]!.headers.get("authorization"))).toBe(true);
    expect(requests[1]!.headers.get("authorization")).not.toBe(`Bearer ${installationToken}`);
  });

  it("lists the installation's repositories instead of the user's", async () => {
    const requests = stubFetch([
      () => mintResponse(),
      () =>
        Response.json({
          total_count: 2,
          repository_selection: "selected",
          repositories: [
            { id: 1, name: "Kairos", full_name: "bakey/Kairos" },
            { id: 2, name: "WuYu-BizBuddy", full_name: "bakey/WuYu-BizBuddy" },
          ],
        }),
    ]);

    const result = await executors["github.list_my_repositories"]!(
      { perPage: 100, page: 1, sort: "updated" },
      installationContext,
    );

    expect(result).toMatchObject({
      ok: true,
      output: { repositories: [{ full_name: "bakey/Kairos" }, { full_name: "bakey/WuYu-BizBuddy" }] },
    });
    // The action declares `{ repositories }`; the installation envelope's `total_count` is not leaked.
    expect((result as { output: Record<string, unknown> }).output).not.toHaveProperty("total_count");
    const url = new URL(requests[1]!.url);
    expect(url.pathname).toBe("/installation/repositories");
    expect(url.searchParams.get("per_page")).toBe("100");
    expect(url.searchParams.get("page")).toBe("1");
    // The installation listing has no sort; the user-listing parameter is not forwarded.
    expect(url.searchParams.has("sort")).toBe(false);
    expect(requests[1]!.headers.get("authorization")).toBe(`Bearer ${installationToken}`);
  });

  it("keeps the user endpoints for token credentials", async () => {
    const requests = stubFetch([
      () => Response.json({ login: "bakey", id: 1566848 }),
      () => Response.json([{ id: 1, name: "Kairos", full_name: "bakey/Kairos" }]),
    ]);

    await executors["github.get_current_user"]!({}, apiKeyContext);
    await executors["github.list_my_repositories"]!({ sort: "updated" }, apiKeyContext);

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(["/user", "/user/repos"]);
    expect(new URL(requests[1]!.url).searchParams.get("sort")).toBe("updated");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer github_pat_secret");
  });

  it("surfaces a refused mint as the action's error instead of calling the endpoint", async () => {
    const requests = stubFetch([() => Response.json({ message: "Bad credentials" }, { status: 401 })]);

    const result = await executors["github.get_repository"]!({ owner: "bakey", repo: "Kairos" }, installationContext);

    expect(result).toMatchObject({ ok: false, error: { message: "Bad credentials" } });
    expect(requests).toHaveLength(1);
  });
});

describe("GitHub App installation validation", () => {
  it("describes the installation and proves a token can be minted", async () => {
    const requests = stubFetch([() => installationResponse(), () => mintResponse()]);

    const result = await credentialValidators.customCredential!(
      { values: { appId, installationId, privateKey } },
      { fetcher: fetch },
    );

    expect(result).toMatchObject({
      profile: {
        accountId: "bakey",
        displayName: "GitHub App installation on bakey",
        grantedScopes: ["issues:read", "metadata:read", "pull_requests:read"],
      },
      metadata: {
        appId,
        installationId,
        accountType: "User",
        repositorySelection: "selected",
        permissions: { issues: "read", metadata: "read", pull_requests: "read" },
      },
    });
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      `GET /app/installations/${installationId}`,
      `POST /app/installations/${installationId}/access_tokens`,
    ]);
    expect(isAppJwt(requests[0]!.headers.get("authorization"))).toBe(true);
  });

  it("refuses an installation the App does not own", async () => {
    stubFetch([() => Response.json({ message: "Not Found" }, { status: 404 })]);

    await expect(
      credentialValidators.customCredential!({ values: { appId, installationId, privateKey } }, { fetcher: fetch }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
