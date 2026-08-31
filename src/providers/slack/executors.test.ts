import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { executors as slackbotExecutors } from "../slackbot/executors.ts";
import { credentialValidators, executors as slackExecutors } from "./executors.ts";

type OAuthCredential = Extract<ResolvedCredential, { authType: "oauth2" }>;

describe("Slack authorization paths", () => {
  it.each([
    { actionId: "slack.list_channels", rawTokenType: "bot", execute: slackExecutors["slack.list_channels"]! },
    {
      actionId: "slackbot.list_channels",
      rawTokenType: "user",
      execute: slackbotExecutors["slackbot.list_channels"]!,
    },
    {
      actionId: "slack.list_channels",
      rawTokenType: "Bearer",
      accessToken: "xoxb-bot-token",
      execute: slackExecutors["slack.list_channels"]!,
    },
    {
      actionId: "slackbot.list_channels",
      rawTokenType: "Bearer",
      accessToken: "xoxp-user-token",
      execute: slackbotExecutors["slackbot.list_channels"]!,
    },
  ])("rejects the other authorization path for $actionId", async ({ rawTokenType, accessToken, execute }) => {
    const context: ExecutionContext = {
      getCredential: async () => oauthCredential(rawTokenType, {}, accessToken),
    };

    await expect(execute({}, context)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "authorization_failed",
      },
    });
  });

  it.each([
    {
      actionId: "slack.open_conversation",
      rawTokenType: "user",
      execute: slackExecutors["slack.open_conversation"]!,
    },
    {
      actionId: "slackbot.open_conversation",
      rawTokenType: "bot",
      execute: slackbotExecutors["slackbot.open_conversation"]!,
    },
    {
      actionId: "slack.open_conversation",
      rawTokenType: "Bearer",
      accessToken: "xoxp-user-token",
      execute: slackExecutors["slack.open_conversation"]!,
    },
  ])("allows the matching authorization path for $actionId", async ({ rawTokenType, accessToken, execute }) => {
    const context: ExecutionContext = {
      getCredential: async () => oauthCredential(rawTokenType, {}, accessToken),
    };

    await expect(execute({ userIds: [] }, context)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        message: "open_conversation only supports one userId",
      },
    });
  });

  it.each([
    {
      tokenType: "user",
      accessToken: "access-token",
      metadata: {
        rawTokenType: "user",
        scope: "channels:read",
        authed_user: { scope: "chat:write,search:read" },
      },
      scopes: ["chat:write", "search:read"],
    },
    {
      tokenType: "Bearer user",
      accessToken: "xoxp-user-token",
      metadata: {
        rawTokenType: "Bearer",
        scope: "channels:read,chat:write,search:read",
      },
      scopes: ["channels:read", "chat:write", "search:read"],
    },
    {
      tokenType: "bot",
      accessToken: "access-token",
      metadata: {
        rawTokenType: "bot",
        scope: "channels:read,chat:write",
        authed_user: { scope: "search:read" },
      },
      scopes: ["channels:read", "chat:write"],
    },
  ])("reads scopes from a $tokenType token response", async ({ accessToken, tokenType, metadata, scopes }) => {
    const result = await credentialValidators.oauth2!(oauthCredential(tokenType, metadata, accessToken), {
      fetcher: async (url, init) => {
        expect(url.toString()).toBe("https://slack.com/api/auth.test");
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
        return Response.json({ ok: true, team: "Example workspace", user_id: "U123" });
      },
    });

    expect(result).toMatchObject({
      profile: {
        accountId: "U123",
        displayName: "Example workspace",
      },
      grantedScopes: scopes,
    });
  });
});

function oauthCredential(
  rawTokenType: string,
  metadata: Record<string, unknown> = {},
  accessToken = "access-token",
): OAuthCredential {
  return {
    authType: "oauth2",
    accessToken,
    tokenType: rawTokenType,
    profile: {
      accountId: "U123",
      displayName: "Example workspace",
      grantedScopes: [],
    },
    metadata: { ...metadata, rawTokenType },
  };
}

describe("Slack ACL enumeration and api_key authorization", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    { actionId: "slack.list_channels", apiKey: "xoxb-bot-token", execute: slackExecutors["slack.list_channels"]! },
    { actionId: "slack.list_channels", apiKey: "xoxp-user-token", execute: slackExecutors["slack.list_channels"]! },
    {
      actionId: "slackbot.list_channels",
      apiKey: "xoxb-bot-token",
      execute: slackbotExecutors["slackbot.list_channels"]!,
    },
  ])("accepts an api_key credential of either token kind for $actionId ($apiKey)", async ({ apiKey, execute }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${apiKey}`);
        return Response.json({ ok: true, channels: [{ id: "C1", name: "general" }] });
      }),
    );
    const context: ExecutionContext = {
      getCredential: async () => apiKeyCredential(apiKey),
    };

    await expect(execute({}, context)).resolves.toMatchObject({
      ok: true,
      output: { channels: [{ channelId: "C1", name: "general" }] },
    });
  });

  it("passes channel, cursor and limit to conversations.members and remaps the envelope", async () => {
    const execute = slackExecutors["slack.conversations_members"]!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const target = new URL(input.toString());
        expect(`${target.origin}${target.pathname}`).toBe("https://slack.com/api/conversations.members");
        expect(target.searchParams.get("channel")).toBe("C024BE91L");
        expect(target.searchParams.get("cursor")).toBe("dXNlcjpVMDYxTkZUVDI=");
        expect(target.searchParams.get("limit")).toBe("200");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xoxb-bot-token");
        return Response.json({
          ok: true,
          members: ["U023BECGF", "U061F7AUR", "W012A3CDE"],
          response_metadata: { next_cursor: "e3VzZXJfaWQ6IFcxMjM0NTY3fQ==" },
        });
      }),
    );
    const context: ExecutionContext = {
      getCredential: async () => apiKeyCredential("xoxb-bot-token"),
    };

    await expect(execute({ channelId: "C024BE91L", cursor: "dXNlcjpVMDYxTkZUVDI=", limit: 200 }, context)).resolves
      .toMatchObject({
        ok: true,
        output: {
          memberIds: ["U023BECGF", "U061F7AUR", "W012A3CDE"],
          nextCursor: "e3VzZXJfaWQ6IFcxMjM0NTY3fQ==",
        },
      });
  });

  it("returns an empty nextCursor when Slack sends none, so callers can terminate", async () => {
    const execute = slackExecutors["slack.conversations_members"]!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true, members: ["U023BECGF"] })),
    );
    const context: ExecutionContext = {
      getCredential: async () => apiKeyCredential("xoxb-bot-token"),
    };

    await expect(execute({ channelId: "C024BE91L" }, context)).resolves.toMatchObject({
      ok: true,
      output: { memberIds: ["U023BECGF"], nextCursor: "" },
    });
  });

  it("slackbot inherits conversations_members", () => {
    expect(slackbotExecutors["slackbot.conversations_members"]).toBeDefined();
  });

  it("declares api_key on the slack provider definition", async () => {
    const { provider } = await import("./definition.ts");
    expect(provider.authTypes).toContain("api_key");
  });

  it("validates an api_key credential against auth.test and keeps the team in metadata", async () => {
    const result = await credentialValidators.apiKey!(apiKeyCredential("xoxb-bot-token"), {
      fetcher: async (url, init) => {
        expect(url.toString()).toBe("https://slack.com/api/auth.test");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xoxb-bot-token");
        return Response.json({
          ok: true,
          team: "Example workspace",
          team_id: "T024BE7LD",
          user_id: "U0G9QF9C6",
        });
      },
    });

    expect(result).toMatchObject({
      profile: {
        accountId: "U0G9QF9C6",
        displayName: "Example workspace",
      },
      metadata: {
        currentAccount: { team_id: "T024BE7LD" },
      },
    });
  });
});

function apiKeyCredential(apiKey: string): Extract<ResolvedCredential, { authType: "api_key" }> {
  return {
    authType: "api_key",
    apiKey,
    values: { apiKey },
    profile: {
      accountId: "U0G9QF9C6",
      displayName: "Example workspace",
      grantedScopes: [],
    },
    metadata: {},
  };
}
