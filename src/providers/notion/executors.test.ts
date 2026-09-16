import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { describe, expect, it, vi } from "vitest";
import { credentialValidators, executors } from "./executors.ts";

type OAuthCredential = Extract<ResolvedCredential, { authType: "oauth2" }>;
type ApiKeyCredential = Extract<ResolvedCredential, { authType: "api_key" }>;

const WORKSPACE = "3C1A0E8F2B4D4E6A8F019B2C3D4E5F60";
const ALICE = "550e8400-e29b-41d4-a716-446655440000";
const BOT = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/** A stored OAuth credential as `oauth-flow-service` writes it: the token
 *  exchange response minus its secrets, on `metadata`. */
function grant(metadata: Record<string, unknown>): OAuthCredential {
  return {
    authType: "oauth2",
    accessToken: "ntn_live",
    tokenType: "Bearer",
    profile: { accountId: BOT, displayName: "Skardi", grantedScopes: [] },
    metadata,
  };
}

/** The token-exchange metadata Notion issues for a user-owned grant. */
function userGrant(): Record<string, unknown> {
  return {
    workspace_id: WORKSPACE,
    workspace_name: "Skardi",
    bot_id: "bot-51",
    owner: { type: "user", user: { object: "user", id: ALICE, name: "Alice Example" } },
  };
}

function internalIntegration(): ApiKeyCredential {
  return {
    authType: "api_key",
    apiKey: "secret_pasted",
    values: { apiKey: "secret_pasted" },
    profile: { accountId: BOT, displayName: "Skardi", grantedScopes: [] },
    // What the validator stored: the `/users/me` bot object. No workspace id
    // exists anywhere for this credential kind.
    metadata: { object: "user", id: BOT, type: "bot", bot: { workspace_name: "Skardi" } },
  };
}

function contextFor(credential: ResolvedCredential): ExecutionContext {
  return { getCredential: async () => credential };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("notion.get_current_user", () => {
  it("reads the workspace and owning user off the stored grant, with no network call", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    try {
      const result = await executors["notion.get_current_user"]!({}, contextFor(grant(userGrant())));
      expect(result).toEqual({
        ok: true,
        output: {
          workspaceId: WORKSPACE,
          workspaceName: "Skardi",
          userId: ALICE,
          userName: "Alice Example",
          isBot: false,
        },
      });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("answers a bot for a grant whose owner is the workspace, and null for what it does not know", async () => {
    const result = await executors["notion.get_current_user"]!(
      {},
      contextFor(grant({ workspace_id: WORKSPACE, owner: { type: "workspace", workspace: true } })),
    );
    expect(result).toEqual({
      ok: true,
      output: { workspaceId: WORKSPACE, workspaceName: null, userId: null, userName: null, isBot: true },
    });
  });

  it("refuses a credential whose grant names no workspace — an internal integration cannot", async () => {
    const result = await executors["notion.get_current_user"]!({}, contextFor(internalIntegration()));
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_credential_metadata", message: expect.stringContaining("workspace_id") },
    });
  });
});

describe("notion.retrieve_page_markdown", () => {
  const PAGE = "7B2E4C1A-9D3F-4E5B-8A6C-1F2D3E4B5A60";

  function notionApi(pageBody: unknown, markdownBody: unknown) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      if (url.endsWith(`/v1/pages/${PAGE}`)) return jsonResponse(pageBody);
      if (url.includes(`/v1/pages/${PAGE}/markdown`)) return jsonResponse(markdownBody);
      return jsonResponse({ object: "error", code: "object_not_found", message: url }, 404);
    });
    return { fetcher, calls };
  }

  async function run(pageBody: unknown, markdownBody: unknown, input: Record<string, unknown> = { pageId: PAGE }) {
    const { fetcher, calls } = notionApi(pageBody, markdownBody);
    vi.stubGlobal("fetch", fetcher);
    try {
      const result = await executors["notion.retrieve_page_markdown"]!(input, contextFor(grant(userGrant())));
      return { result, calls };
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("constructs the row: the input's page id, the render, and the page object's revision", async () => {
    const { result, calls } = await run(
      // Notion spells the id its own way in the body; the row keeps the input's.
      { object: "page", id: PAGE.toLowerCase(), last_edited_time: "2026-09-01T10:00:00.000Z" },
      { object: "page_markdown", id: PAGE.toLowerCase(), markdown: "# Hi", truncated: false, unknown_block_ids: [] },
    );
    expect(result).toEqual({
      ok: true,
      output: {
        pageId: PAGE,
        markdown: "# Hi",
        truncated: false,
        unknownBlockIds: [],
        lastEditedTime: "2026-09-01T10:00:00.000Z",
      },
    });
    // Page object first — the cheap reachability question — then the render,
    // both at the API version the markdown endpoint requires.
    expect(calls.map((c) => c.url)).toEqual([
      `https://api.notion.com/v1/pages/${PAGE}`,
      `https://api.notion.com/v1/pages/${PAGE}/markdown`,
    ]);
    for (const call of calls) {
      expect(call.headers["notion-version"]).toBe("2026-03-11");
    }
  });

  it("coerces what a render may omit: markdown to '', truncated to false, unknown ids to []", async () => {
    const { result } = await run(
      { object: "page", id: PAGE, last_edited_time: "2026-09-01T10:00:00.000Z" },
      { object: "page_markdown", id: PAGE },
    );
    expect(result).toMatchObject({ ok: true, output: { markdown: "", truncated: false, unknownBlockIds: [] } });
  });

  it("keeps a partial render's evidence and drops non-string ids", async () => {
    const { result } = await run(
      { object: "page", id: PAGE, last_edited_time: "2026-09-01T10:00:00.000Z" },
      { object: "page_markdown", id: PAGE, markdown: "…", truncated: true, unknown_block_ids: ["b1", 7, "b2"] },
    );
    expect(result).toMatchObject({ ok: true, output: { truncated: true, unknownBlockIds: ["b1", "b2"] } });
  });

  it("forwards includeTranscript as Notion's query parameter", async () => {
    const { calls } = await run(
      { object: "page", id: PAGE, last_edited_time: "2026-09-01T10:00:00.000Z" },
      { object: "page_markdown", id: PAGE, markdown: "" },
      { pageId: PAGE, includeTranscript: true },
    );
    expect(calls[1]!.url).toBe(`https://api.notion.com/v1/pages/${PAGE}/markdown?include_transcript=true`);
  });

  it("refuses a page object with no revision rather than inventing one", async () => {
    const { result } = await run({ object: "page", id: PAGE }, { object: "page_markdown", id: PAGE, markdown: "x" });
    expect(result).toMatchObject({ ok: false, error: { code: "provider_error" } });
  });

  it("answers a page this grant cannot reach before attempting the render", async () => {
    const { fetcher } = notionApi(undefined, undefined);
    fetcher.mockImplementationOnce(async () =>
      jsonResponse({ object: "error", code: "object_not_found", message: "Could not find page" }, 404),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      const result = await executors["notion.retrieve_page_markdown"]!(
        { pageId: PAGE },
        contextFor(grant(userGrant())),
      );
      expect(result).toMatchObject({ ok: false, error: { details: { status: 404 } } });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("notion oauth2 credential validation", () => {
  const me = { object: "user", id: BOT, type: "bot", name: "Skardi Bot", bot: { workspace_name: "Skardi" } };

  it("names the OWNING USER as the profile, not the bot /users/me describes", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => jsonResponse(me));
    const result = await credentialValidators.oauth2!(grant(userGrant()), { fetcher });
    expect(result).toMatchObject({ profile: { accountId: ALICE, displayName: "Alice Example" } });
    // The liveness call still ran: a stale token must be refused here, not at
    // the first action.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe("https://api.notion.com/v1/users/me");
  });

  it("falls back to the bot profile for a grant that names no user", async () => {
    const fetcher = vi.fn(async () => jsonResponse(me));
    const result = await credentialValidators.oauth2!(
      grant({ workspace_id: WORKSPACE, owner: { type: "workspace", workspace: true } }),
      { fetcher },
    );
    expect(result).toMatchObject({ profile: { accountId: BOT, displayName: "Skardi" } });
  });

  it("still refuses a dead token whatever the grant says", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ object: "error", code: "unauthorized", message: "API token is invalid." }, 401),
    );
    await expect(credentialValidators.oauth2!(grant(userGrant()), { fetcher })).rejects.toMatchObject({ status: 401 });
  });
});
