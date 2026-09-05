import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { Validator } from "@cfworker/json-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateActionInput } from "../../core/validation.ts";
import { slackbotActions } from "../slackbot/actions.ts";
import { executors as slackbotExecutors } from "../slackbot/executors.ts";
import { slackActions } from "./actions.ts";
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

    await expect(
      execute({ channelId: "C024BE91L", cursor: "dXNlcjpVMDYxTkZUVDI=", limit: 200 }, context),
    ).resolves.toMatchObject({
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

describe("get_channel_messages pagination", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes the cursor through and surfaces nextCursor", async () => {
    const execute = slackExecutors["slack.get_channel_messages"]!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const target = new URL(input.toString());
        expect(target.searchParams.get("cursor")).toBe("bmV4dF90czox");
        return Response.json({
          ok: true,
          messages: [{ ts: "1711.0001", user: "U023BECGF", text: "hi" }],
          has_more: true,
          response_metadata: { next_cursor: "bmV4dF90czoy" },
        });
      }),
    );
    const context: ExecutionContext = {
      getCredential: async () => apiKeyCredential("xoxb-bot-token"),
    };

    await expect(execute({ channelId: "C024BE91L", cursor: "bmV4dF90czox" }, context)).resolves.toMatchObject({
      ok: true,
      output: {
        messages: [{ ts: "1711.0001", userId: "U023BECGF", text: "hi" }],
        hasMore: true,
        nextCursor: "bmV4dF90czoy",
      },
    });
  });

  it("answers an empty nextCursor on the last page", async () => {
    const execute = slackExecutors["slack.get_channel_messages"]!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true, messages: [], has_more: false })),
    );
    const context: ExecutionContext = {
      getCredential: async () => apiKeyCredential("xoxb-bot-token"),
    };

    await expect(execute({ channelId: "C024BE91L" }, context)).resolves.toMatchObject({
      ok: true,
      output: { messages: [], hasMore: false, nextCursor: "" },
    });
  });
});

describe("Slack current credential identity", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("exposes a scope-free, empty-input identity contract only on Slack", () => {
    const action = slackActions.find((action) => action.id === "slack.get_current_user");
    expect(action).toBeDefined();
    expect(action!.requiredScopes).toEqual([]);
    expect(validateActionInput(action!, {}).valid).toBe(true);
    expect(validateActionInput(action!, { teamId: "TOTHER" }).valid).toBe(false);
    const output = new Validator(action!.outputSchema);
    expect(output.validate({ teamId: "T123", userId: "U123", isBot: false }).valid).toBe(true);
    for (const invalid of [
      { userId: "U123", isBot: false },
      { teamId: "T123", isBot: false },
      { teamId: "T123", userId: "U123" },
      { teamId: "", userId: "U123", isBot: false },
      { teamId: "T123", userId: "", isBot: false },
    ]) {
      expect(output.validate(invalid).valid).toBe(false);
    }
    expect(slackbotActions.some((action) => action.name === "get_current_user")).toBe(false);
    expect(slackbotExecutors["slackbot.get_current_user"]).toBeUndefined();
  });

  it.each([
    { credential: oauthCredential("user", {}, "opaque-user-token"), botId: undefined, isBot: false },
    { credential: oauthCredential("user", {}, "xoxp-user-token"), botId: "B123", isBot: true },
    { credential: apiKeyCredential("xoxb-misleading-prefix"), botId: undefined, isBot: false },
    { credential: apiKeyCredential("opaque-bot-token"), botId: "B123", isBot: true },
  ])("uses auth.test identity and bot_id for $credential.authType ($isBot)", async ({ credential, botId, isBot }) => {
    const execute = slackExecutors["slack.get_current_user"];
    expect(execute).toBeDefined();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toBe("https://slack.com/api/auth.test");
        expect(init?.method).toBe("POST");
        expect(init?.body).toBeUndefined();
        const token = credential.authType === "oauth2" ? credential.accessToken : credential.apiKey;
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
        return Response.json({ ok: true, team_id: "T024BE7LD", user_id: "U024BE7LH", bot_id: botId });
      }),
    );
    await expect(
      execute!(
        {},
        {
          getCredential: async (service) => {
            expect(service).toBe("slack");
            return credential;
          },
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      output: { teamId: "T024BE7LD", userId: "U024BE7LH", isBot },
    });
  });

  it.each([
    {},
    { team_id: "T123", user_id: "U123" },
    { ok: "true", team_id: "T123", user_id: "U123" },
    { ok: true, user_id: "U123" },
    { ok: true, team_id: "T123" },
    { ok: true, team_id: "", user_id: "U123" },
    { ok: true, team_id: "T123", user_id: " " },
    { ok: true, team_id: 123, user_id: "U123" },
    { ok: true, team_id: "T123", user_id: null },
    { ok: true, team_id: " T123", user_id: "U123" },
    { ok: true, team_id: "T123", user_id: "U123", bot_id: "" },
    { ok: true, team_id: "T123", user_id: "U123", bot_id: false },
    { ok: true, team_id: "T123", user_id: "U123", bot_id: null },
  ])("rejects malformed auth.test identity %j", async (payload) => {
    const execute = slackExecutors["slack.get_current_user"];
    expect(execute).toBeDefined();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(payload)),
    );
    const result = await execute!({}, { getCredential: async () => oauthCredential("user") });
    expect(result).toMatchObject({ ok: false, error: { code: "provider_error", details: { status: 502 } } });
    expect(result).not.toHaveProperty("output");
  });

  it("propagates a rejected credential instead of returning an identity", async () => {
    const execute = slackExecutors["slack.get_current_user"];
    expect(execute).toBeDefined();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: false, error: "invalid_auth" })),
    );
    await expect(execute!({}, { getCredential: async () => oauthCredential("user") })).resolves.toMatchObject({
      ok: false,
      error: { code: "authorization_failed" },
    });
  });
});
