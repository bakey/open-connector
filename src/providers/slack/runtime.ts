import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { ProviderActionHandlers } from "../provider-runtime.ts";
import type { OAuthProviderContext } from "../provider-runtime.ts";
import type { SlackNormalizedConversationType } from "./constants.ts";

import { compactObject, optionalBoolean, optionalRecord, optionalString, requiredString } from "../../core/cast.ts";
import { assertPublicHttpUrl, readBoundedResponseBytes } from "../../core/request.ts";
import {
  createProviderTimeout,
  defineProviderExecutors,
  isAbortLikeError,
  ProviderRequestError,
  providerUserAgent,
} from "../provider-runtime.ts";
import { slackConversationTypes } from "./constants.ts";

export const slackApiBaseUrl = "https://slack.com/api";
const slackFileUrlMaxBytes = 100 * 1024 * 1024;

type SlackActionContext = Omit<OAuthProviderContext, "providerSecret" | "tokenType">;
type SlackOAuthTokenKind = "bot" | "user";

interface SlackPayloadError {
  ok?: boolean;
  error?: string;
  response_metadata?: Record<string, unknown>;
}

interface SlackRequestJsonInput {
  method: string;
  accessToken: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
  body?: Record<string, unknown>;
}

export type SlackActionHandler = (input: Record<string, unknown>, context: SlackActionContext) => Promise<unknown>;

/** Build Slack executors that reject credentials issued for the other authorization path. */
export function defineSlackProviderExecutors(
  service: "slack" | "slackbot",
  tokenKind: SlackOAuthTokenKind,
  handlers: Record<string, SlackActionHandler>,
): ProviderExecutors {
  return defineProviderExecutors<SlackActionContext>({
    service,
    handlers,
    async createContext(context, fetcher): Promise<SlackActionContext> {
      const credential = await context.getCredential(service);
      let accessToken: string;
      if (credential?.authType === "oauth2") {
        if (readSlackTokenKind(credential.accessToken, credential.metadata) != tokenKind) {
          throw new ProviderRequestError(
            401,
            `Reconnect ${service} with ${tokenKind} authorization before running its actions.`,
          );
        }
        accessToken = credential.accessToken;
      } else if (credential?.authType === "api_key") {
        // A pasted token was authorized by no OAuth flow, so the user/bot flow
        // gate above has nothing to check for it; Slack enforces its own
        // per-method token rules. Mirrors github and notion, whose api_key arm
        // is likewise "use this bearer as-is".
        accessToken = credential.apiKey;
      } else {
        throw new ProviderRequestError(401, `Configure ${service} credentials first.`);
      }
      const providerContext: SlackActionContext = {
        accessToken,
        fetcher,
        signal: context.signal,
      };
      if (context.transitFiles) {
        providerContext.transitFiles = context.transitFiles;
      }
      return providerContext;
    },
  });
}

export const slackActionHandlers: ProviderActionHandlers<"slack", SlackActionHandler> = {
  get_current_user(_input, context) {
    return slackGetCurrentUser(context);
  },
  list_channels(input, context) {
    return slackListChannels(input, context);
  },
  get_channel_messages(input, context) {
    return slackGetChannelMessages(input, context);
  },
  conversations_members(input, context) {
    return slackConversationsMembers(input, context);
  },
  search_messages(input, context) {
    return slackSearchMessages(input, context);
  },
  search_context(input, context) {
    return slackSearchContext(input, context);
  },
  post_message(input, context) {
    return slackPostMessage(input, context);
  },
  reply_message(input, context) {
    return slackReplyMessage(input, context);
  },
  get_thread(input, context) {
    return slackGetThread(input, context);
  },
  list_conversations(input, context) {
    return slackListConversations(input, context);
  },
  get_conversation(input, context) {
    return slackGetConversation(input, context);
  },
  open_conversation(input, context) {
    return slackOpenConversation(input, context);
  },
  list_users(input, context) {
    return slackListUsers(input, context);
  },
  get_user(input, context) {
    return slackGetUser(input, context);
  },
  post_ephemeral_message(input, context) {
    return slackPostEphemeralMessage(input, context);
  },
  get_message_permalink(input, context) {
    return slackGetMessagePermalink(input, context);
  },
  update_message(input, context) {
    return slackUpdateMessage(input, context);
  },
  delete_message(input, context) {
    return slackDeleteMessage(input, context);
  },
  schedule_message(input, context) {
    return slackScheduleMessage(input, context);
  },
  add_reaction(input, context) {
    return slackAddReaction(input, context);
  },
  remove_reaction(input, context) {
    return slackRemoveReaction(input, context);
  },
  get_reactions(input, context) {
    return slackGetReactions(input, context);
  },
  upload_file(input, context) {
    return slackUploadFile(input, context);
  },
  list_files(input, context) {
    return slackListFiles(input, context);
  },
  get_file(input, context) {
    return slackGetFile(input, context);
  },
  delete_file(input, context) {
    return slackDeleteFile(input, context);
  },
};

export const slackCredentialValidators: CredentialValidators = {
  async apiKey(input, { fetcher, signal }) {
    const payload = await slackRequestJson<{
      ok: boolean;
      team?: string;
      team_id?: string;
      user_id?: string;
      error?: string;
    }>({
      accessToken: input.apiKey,
      fetcher,
      signal,
      method: "auth.test",
    });

    return {
      profile: {
        accountId: payload.user_id ?? payload.team_id ?? "slack:api_key",
        displayName: payload.team ?? payload.team_id ?? payload.user_id ?? "Slack Workspace",
      },
      metadata: {
        currentAccount: payload,
      },
    };
  },
  async oauth2(input, { fetcher, signal }) {
    const payload = await slackRequestJson<{
      ok: boolean;
      team?: string;
      team_id?: string;
      user_id?: string;
      error?: string;
    }>({
      accessToken: input.accessToken,
      fetcher,
      signal,
      method: "auth.test",
    });

    const responseScopes = readSlackCredentialScopes(input.accessToken, input.metadata);

    return {
      profile: {
        accountId: payload.user_id ?? payload.team_id ?? "slack:oauth2",
        displayName: payload.team ?? payload.team_id ?? payload.user_id ?? "Slack Workspace",
      },
      grantedScopes: responseScopes.length > 0 ? responseScopes : input.profile.grantedScopes,
      metadata: {
        currentAccount: payload,
      },
    };
  },
};

async function slackGetCurrentUser(context: SlackActionContext): Promise<unknown> {
  const payload = await slackRequestJson<
    SlackPayloadError & {
      team_id?: unknown;
      user_id?: unknown;
      bot_id?: unknown;
    }
  >({ ...context, method: "auth.test" });

  if (payload.ok !== true) {
    throw slackResponseError("auth.test ok");
  }
  // Identity is upstream data, not a token-prefix or cached profile inference.
  // Refuse whitespace normalization so malformed identity never becomes a key.
  for (const field of ["team_id", "user_id", "bot_id"] as const) {
    const value = payload[field];
    if (field === "bot_id" && value === undefined) {
      continue;
    }
    if (typeof value !== "string" || !value || value.trim() !== value) {
      throw slackResponseError(`auth.test ${field}`);
    }
  }
  return { teamId: payload.team_id, userId: payload.user_id, isBot: payload.bot_id !== undefined };
}

async function slackListChannels(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  const url = slackApiUrl("conversations.list");
  if (input.limit != null) {
    url.searchParams.set("limit", String(input.limit));
  }

  const payload = await slackGetJson<{
    ok: boolean;
    channels?: Array<{ id: string; name: string }>;
    error?: string;
  }>(url, context);

  return {
    channels: (payload.channels ?? []).map((channel) => ({
      channelId: channel.id,
      name: channel.name,
    })),
  };
}

async function slackGetChannelMessages(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  const url = slackApiUrl("conversations.history");
  url.searchParams.set("channel", String(input.channelId));
  if (input.limit != null) {
    url.searchParams.set("limit", String(input.limit));
  }
  if (input.cursor != null) {
    url.searchParams.set("cursor", String(input.cursor));
  }

  const payload = await slackGetJson<{
    ok: boolean;
    messages?: Array<{ ts: string; user?: string; text?: string }>;
    has_more?: boolean;
    response_metadata?: { next_cursor?: string };
    error?: string;
  }>(url, context);

  return {
    messages: (payload.messages ?? []).map((message) => ({
      ts: message.ts,
      userId: message.user ?? "",
      text: message.text ?? "",
    })),
    hasMore: payload.has_more ?? false,
    nextCursor: payload.response_metadata?.next_cursor ?? "",
  };
}

async function slackConversationsMembers(
  input: Record<string, unknown>,
  context: SlackActionContext,
): Promise<unknown> {
  const url = slackApiUrl("conversations.members");
  url.searchParams.set("channel", String(input.channelId));
  if (input.cursor != null) {
    url.searchParams.set("cursor", String(input.cursor));
  }
  if (input.limit != null) {
    url.searchParams.set("limit", String(input.limit));
  }

  const payload = await slackGetJson<{
    ok: boolean;
    members?: string[];
    response_metadata?: { next_cursor?: string };
    error?: string;
  }>(url, context);

  return {
    memberIds: payload.members ?? [],
    nextCursor: payload.response_metadata?.next_cursor ?? "",
  };
}

async function slackSearchMessages(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  const query = requiredString(input.query, "query", (message) => new ProviderRequestError(400, message));
  if (input.page != null && input.cursor != null) {
    throw new ProviderRequestError(400, "page and cursor cannot be used together");
  }
  const url = slackApiUrl("search.messages");
  url.searchParams.set("query", query);
  if (input.count != null) {
    url.searchParams.set("count", String(input.count));
  }
  if (input.page != null) {
    url.searchParams.set("page", String(input.page));
  }
  if (input.cursor != null) {
    url.searchParams.set("cursor", String(input.cursor));
  }
  if (input.highlight != null) {
    url.searchParams.set("highlight", String(input.highlight));
  }
  if (input.sort != null) {
    url.searchParams.set("sort", String(input.sort));
  }
  if (input.sortDir != null) {
    url.searchParams.set("sort_dir", String(input.sortDir));
  }
  if (input.teamId != null) {
    url.searchParams.set("team_id", String(input.teamId));
  }

  const payload = await slackGetJson<{
    ok: boolean;
    query?: string;
    messages?: {
      matches?: Array<Record<string, unknown>>;
      total?: number;
      pagination?: Record<string, unknown>;
      paging?: Record<string, unknown>;
    };
    response_metadata?: { next_cursor?: string };
    error?: string;
  }>(url, context);

  return {
    query: optionalString(payload.query) ?? query,
    matches: (payload.messages?.matches ?? []).map((match) => normalizeSearchMessageMatch(match)),
    total: typeof payload.messages?.total === "number" ? payload.messages.total : 0,
    pagination: payload.messages?.pagination ?? {},
    paging: payload.messages?.paging ?? {},
    nextCursor: normalizeNextCursor(payload.response_metadata?.next_cursor),
  };
}

async function slackSearchContext(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  const query = requiredString(input.query, "query", (message) => new ProviderRequestError(400, message));
  const payload = await slackRequestJson<{
    ok: boolean;
    results?: { messages?: Array<Record<string, unknown>> };
    response_metadata?: { next_cursor?: string };
    error?: string;
  }>({
    ...context,
    method: "assistant.search.context",
    body: {
      query,
      content_types: ["messages"],
      channel_types: Array.isArray(input.channelTypes) ? input.channelTypes : undefined,
      context_channel_id: optionalString(input.contextChannelId),
      cursor: optionalString(input.cursor),
      limit: input.limit,
      sort: input.sort,
      sort_dir: input.sortDir,
      before: input.before,
      after: input.after,
      include_context_messages: optionalBoolean(input.includeContextMessages),
      include_bots: optionalBoolean(input.includeBots),
      include_message_blocks: optionalBoolean(input.includeMessageBlocks),
      highlight: optionalBoolean(input.highlight),
      term_clauses: Array.isArray(input.termClauses) ? input.termClauses : undefined,
      modifiers: optionalString(input.modifiers),
      include_archived_channels: optionalBoolean(input.includeArchivedChannels),
      disable_semantic_search: optionalBoolean(input.disableSemanticSearch),
    },
  });
  return {
    messages: payload.results?.messages ?? [],
    nextCursor: normalizeNextCursor(payload.response_metadata?.next_cursor),
  };
}

async function slackPostMessage(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  const payload = await slackRequestJson<{
    ok: boolean;
    ts?: string;
    channel?: string;
    error?: string;
  }>({
    ...context,
    method: "chat.postMessage",
    body: buildSlackMessagePayload(input),
  });

  return {
    ts: payload.ts ?? "",
    channelId: payload.channel ?? String(input.channelId),
  };
}

async function slackReplyMessage(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  const payload = await slackRequestJson<{
    ok: boolean;
    ts?: string;
    channel?: string;
    error?: string;
  }>({
    ...context,
    method: "chat.postMessage",
    body: buildSlackMessagePayload(input, {
      thread_ts: String(input.threadTs),
      reply_broadcast: optionalBoolean(input.replyBroadcast),
    }),
  });

  return {
    ts: payload.ts ?? "",
    channelId: payload.channel ?? String(input.channelId),
  };
}

async function slackGetThread(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  const url = slackApiUrl("conversations.replies");
  url.searchParams.set("channel", String(input.channelId));
  url.searchParams.set("ts", String(input.threadTs));

  const payload = await slackGetJson<{
    ok: boolean;
    messages?: Array<{ ts: string; user?: string; text?: string }>;
    has_more?: boolean;
    error?: string;
  }>(url, context);

  return {
    messages: (payload.messages ?? []).map((message) => ({
      ts: message.ts,
      userId: message.user ?? "",
      text: message.text ?? "",
    })),
    hasMore: payload.has_more ?? false,
  };
}

async function slackListConversations(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  const url = slackApiUrl("conversations.list");
  url.searchParams.set("limit", String(input.limit ?? 200));
  url.searchParams.set(
    "types",
    Array.isArray(input.types) ? input.types.map((value) => String(value)).join(",") : slackConversationTypes.join(","),
  );
  if (input.cursor != null) {
    url.searchParams.set("cursor", String(input.cursor));
  }
  if (input.excludeArchived != null) {
    url.searchParams.set("exclude_archived", String(input.excludeArchived));
  }

  const payload = await slackGetJson<{
    ok: boolean;
    channels?: unknown;
    response_metadata?: Record<string, unknown>;
    error?: string;
  }>(url, context);

  // Discovery may prune against this page. Never manufacture an empty list or
  // terminal cursor from an unreadable enumeration response.
  if (!Array.isArray(payload.channels)) {
    throw slackResponseError("conversations.list channels");
  }
  const metadata = optionalRecord(payload.response_metadata);
  if (payload.response_metadata !== undefined && !metadata) {
    throw slackResponseError("conversations.list response_metadata");
  }
  const cursor = metadata?.next_cursor;
  // Slack documents absent, null and empty cursors as terminal. A present
  // non-string or padded cursor is malformed, not evidence the walk finished.
  if (cursor != null && (typeof cursor !== "string" || cursor.trim() !== cursor)) {
    throw slackResponseError("conversations.list next_cursor");
  }
  return {
    conversations: payload.channels.map((channel) => normalizeListedConversation(channel)),
    nextCursor: typeof cursor === "string" ? normalizeNextCursor(cursor) : null,
  };
}

async function slackGetConversation(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  const url = slackApiUrl("conversations.info");
  url.searchParams.set("channel", String(input.channelId));
  if (input.includeLocale != null) {
    url.searchParams.set("include_locale", String(input.includeLocale));
  }
  if (input.includeNumMembers != null) {
    url.searchParams.set("include_num_members", String(input.includeNumMembers));
  }

  const payload = await slackGetJson<{
    ok: boolean;
    channel?: Record<string, unknown>;
    error?: string;
  }>(url, context);

  return {
    conversation: normalizeConversation(payload.channel ?? {}),
  };
}

async function slackOpenConversation(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  const userIds = Array.isArray(input.userIds) ? input.userIds.map(String) : [];
  if (userIds.length !== 1) {
    throw new ProviderRequestError(400, "open_conversation only supports one userId");
  }

  const payload = await slackRequestJson<{
    ok: boolean;
    channel?: Record<string, unknown>;
    error?: string;
  }>({
    ...context,
    method: "conversations.open",
    body: {
      users: userIds[0],
      return_im: true,
      prevent_creation: optionalBoolean(input.preventCreation),
    },
  });

  const conversation = normalizeConversation(payload.channel ?? {});
  return {
    channelId: conversation.channelId,
    conversation,
  };
}

async function slackListUsers(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  const url = slackApiUrl("users.list");
  url.searchParams.set("limit", String(input.limit ?? 200));
  if (input.cursor != null) {
    url.searchParams.set("cursor", String(input.cursor));
  }
  if (input.includeLocale != null) {
    url.searchParams.set("include_locale", String(input.includeLocale));
  }

  const payload = await slackGetJson<{
    ok: boolean;
    members?: Array<Record<string, unknown>>;
    response_metadata?: { next_cursor?: string };
    error?: string;
  }>(url, context);

  return {
    users: (payload.members ?? []).map((member) => normalizeUser(member)),
    nextCursor: normalizeNextCursor(payload.response_metadata?.next_cursor),
  };
}

async function slackGetUser(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  const url = slackApiUrl("users.info");
  url.searchParams.set("user", String(input.userId));
  if (input.includeLocale != null) {
    url.searchParams.set("include_locale", String(input.includeLocale));
  }

  const payload = await slackGetJson<{
    ok: boolean;
    user?: Record<string, unknown>;
    error?: string;
  }>(url, context);

  return {
    user: normalizeUser(payload.user ?? {}),
  };
}

async function slackPostEphemeralMessage(
  input: Record<string, unknown>,
  context: SlackActionContext,
): Promise<unknown> {
  const payload = await slackRequestJson<{
    ok: boolean;
    channel?: string;
    message_ts?: string;
    error?: string;
  }>({
    ...context,
    method: "chat.postEphemeral",
    body: buildSlackMessagePayload(input, { user: String(input.userId) }),
  });

  return {
    channelId: payload.channel ?? String(input.channelId),
    messageTs: payload.message_ts ?? "",
  };
}

async function slackGetMessagePermalink(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  const url = slackApiUrl("chat.getPermalink");
  url.searchParams.set("channel", String(input.channelId));
  url.searchParams.set("message_ts", String(input.messageTs));

  const payload = await slackGetJson<{
    ok: boolean;
    channel?: string;
    permalink?: string;
    error?: string;
  }>(url, context);

  return {
    channelId: payload.channel ?? String(input.channelId),
    messageTs: String(input.messageTs),
    permalink: payload.permalink ?? "",
  };
}

async function slackUpdateMessage(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  const payload = await slackRequestJson<{
    ok: boolean;
    channel?: string;
    ts?: string;
    error?: string;
  }>({
    ...context,
    method: "chat.update",
    body: buildSlackMessagePayload(input, { ts: String(input.messageTs) }),
  });

  return {
    channelId: payload.channel ?? String(input.channelId),
    messageTs: payload.ts ?? String(input.messageTs),
  };
}

async function slackDeleteMessage(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  const payload = await slackRequestJson<{
    ok: boolean;
    channel?: string;
    ts?: string;
    error?: string;
  }>({
    ...context,
    method: "chat.delete",
    body: {
      channel: String(input.channelId),
      ts: String(input.messageTs),
    },
  });

  return {
    channelId: payload.channel ?? String(input.channelId),
    messageTs: payload.ts ?? String(input.messageTs),
  };
}

async function slackScheduleMessage(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  const postAt = Number(input.postAt);
  if (postAt <= Math.floor(Date.now() / 1000)) {
    throw new ProviderRequestError(400, "postAt must be in the future");
  }

  const payload = await slackRequestJson<{
    ok: boolean;
    channel?: string;
    scheduled_message_id?: string;
    post_at?: number | string;
    error?: string;
  }>({
    ...context,
    method: "chat.scheduleMessage",
    body: buildSlackMessagePayload(input, { post_at: postAt }),
  });

  return {
    channelId: payload.channel ?? String(input.channelId),
    scheduledMessageId: payload.scheduled_message_id ?? "",
    postAt: normalizeScheduledPostAt(payload.post_at, postAt),
  };
}

async function slackAddReaction(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  await slackRequestJson({
    ...context,
    method: "reactions.add",
    body: buildReactionPayload(input),
  });

  return { success: true };
}

async function slackRemoveReaction(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  await slackRequestJson({
    ...context,
    method: "reactions.remove",
    body: buildReactionPayload(input),
  });

  return { success: true };
}

async function slackGetReactions(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  const url = slackApiUrl("reactions.get");
  url.searchParams.set("channel", String(input.channelId));
  url.searchParams.set("timestamp", String(input.messageTs));
  if (typeof input.full === "boolean") {
    url.searchParams.set("full", String(input.full));
  }

  const payload = await slackGetJson<{
    ok: boolean;
    message?: Record<string, unknown>;
    error?: string;
  }>(url, context);

  return {
    item: payload.message ?? {},
  };
}

async function slackUploadFile(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  const content = await resolveSlackFileContent(input, context);
  const filename = String(input.filename);
  const uploadUrlPayload = await slackFormRequestJson<{
    ok: boolean;
    upload_url?: string;
    file_id?: string;
    error?: string;
  }>(context, "files.getUploadURLExternal", {
    filename,
    length: content.byteLength,
    alt_txt: optionalString(input.altText),
    snippet_type: optionalString(input.snippetType),
  });

  const uploadUrl = requiredString(uploadUrlPayload.upload_url, "file.upload_url", slackResponseError);
  const fileId = requiredString(uploadUrlPayload.file_id, "file.file_id", slackResponseError);
  await uploadSlackFileContent(uploadUrl, filename, content, optionalString(input.mimeType), context);

  const completePayload = await slackFormRequestJson<{
    ok: boolean;
    files?: Array<Record<string, unknown>>;
    error?: string;
  }>(context, "files.completeUploadExternal", {
    files: JSON.stringify([
      compactObject({
        id: fileId,
        title: optionalString(input.title),
      }),
    ]),
    channel_id: optionalString(input.channelId),
    initial_comment: optionalString(input.initialComment),
    thread_ts: optionalString(input.threadTs),
  });

  return {
    fileId,
    files: (completePayload.files ?? []).map((file) => normalizeFile(file)),
  };
}

async function slackListFiles(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  const url = slackApiUrl("files.list");
  if (input.channelId != null) {
    url.searchParams.set("channel", String(input.channelId));
  }
  if (input.userId != null) {
    url.searchParams.set("user", String(input.userId));
  }
  if (input.types != null) {
    url.searchParams.set("types", String(input.types));
  }
  if (input.page != null) {
    url.searchParams.set("page", String(input.page));
  }
  if (input.count != null) {
    url.searchParams.set("count", String(input.count));
  }

  const payload = await slackGetJson<{
    ok: boolean;
    files?: Array<Record<string, unknown>>;
    paging?: Record<string, unknown>;
    error?: string;
  }>(url, context);

  return {
    files: (payload.files ?? []).map((file) => normalizeFile(file)),
    paging: payload.paging ?? {},
  };
}

async function slackGetFile(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  const url = slackApiUrl("files.info");
  url.searchParams.set("file", String(input.fileId));

  const payload = await slackGetJson<{
    ok: boolean;
    file?: Record<string, unknown>;
    error?: string;
  }>(url, context);

  return {
    file: normalizeFile(payload.file ?? {}),
  };
}

async function slackDeleteFile(input: Record<string, unknown>, context: SlackActionContext): Promise<unknown> {
  await slackRequestJson({
    ...context,
    method: "files.delete",
    body: {
      file: String(input.fileId),
    },
  });

  return {
    success: true,
    fileId: String(input.fileId),
  };
}

async function slackGetJson<T extends SlackPayloadError>(url: URL, context: SlackActionContext): Promise<T> {
  const response = await context.fetcher(url.toString(), {
    headers: slackHeaders(context.accessToken),
    signal: context.signal,
  });
  return readSlackResponseJson<T>(response);
}

async function slackRequestJson<T extends SlackPayloadError>(input: SlackRequestJsonInput): Promise<T> {
  const response = await input.fetcher(slackApiUrl(input.method).toString(), {
    method: "POST",
    headers: slackHeaders(input.accessToken),
    body: input.body === undefined ? undefined : JSON.stringify(compactObject(input.body)),
    signal: input.signal,
  });
  return readSlackResponseJson<T>(response);
}

async function slackFormRequestJson<T extends SlackPayloadError>(
  context: SlackActionContext,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(compactObject(body))) {
    params.set(key, String(value));
  }

  const response = await context.fetcher(slackApiUrl(method).toString(), {
    method: "POST",
    headers: {
      ...slackHeaders(context.accessToken),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
    signal: context.signal,
  });
  return readSlackResponseJson<T>(response);
}

async function readSlackResponseJson<T extends SlackPayloadError>(response: Response): Promise<T> {
  const payload = (optionalRecord(await response.json().catch(() => undefined)) ?? {}) as T;
  if (!response.ok) {
    throw slackHttpError(response.status, payload, response.headers.get("retry-after"));
  }
  assertSlackPayload(payload);
  // Preserve HTTP/Slack failures (including Retry-After) above, but require
  // affirmative success before any action can normalize an upstream payload.
  if (payload.ok !== true) {
    throw slackResponseError("ok");
  }
  return payload;
}

function buildSlackMessagePayload(
  input: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const payload = compactObject({
    channel: String(input.channelId),
    text: optionalString(input.text),
    blocks: Array.isArray(input.blocks) ? input.blocks : undefined,
    attachments: Array.isArray(input.attachments) ? input.attachments : undefined,
    unfurl_links: optionalBoolean(input.unfurlLinks),
    unfurl_media: optionalBoolean(input.unfurlMedia),
    metadata: optionalRecord(input.metadata),
    ...extra,
  });

  if (!payload.text && !payload.blocks && !payload.attachments) {
    throw new ProviderRequestError(400, "Provide at least one message content field: text, blocks, or attachments.");
  }

  return payload;
}

function buildReactionPayload(input: Record<string, unknown>): Record<string, unknown> {
  return {
    channel: String(input.channelId),
    timestamp: String(input.messageTs),
    name: String(input.name),
  };
}

async function resolveSlackFileContent(
  input: Record<string, unknown>,
  context: SlackActionContext,
): Promise<Uint8Array> {
  const fileUrl = requiredString(input.fileUrl, "fileUrl", (message) => new ProviderRequestError(400, message));
  assertFetchableFileUrl(fileUrl);
  const timeout = createProviderTimeout(context.signal);
  try {
    const response = await context.fetcher(fileUrl, { signal: timeout.signal });
    if (!response.ok) {
      throw new ProviderRequestError(400, `failed to fetch fileUrl: ${response.status}`);
    }
    return await readBoundedResponseBytes(response, {
      maxBytes: slackFileUrlMaxBytes,
      fieldName: "fileUrl",
      createError: (message) => new ProviderRequestError(400, message),
    });
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      throw error;
    }
    if (timeout.didTimeout() && isAbortLikeError(error)) {
      throw new ProviderRequestError(504, "failed to fetch fileUrl: request timed out");
    }
    throw new ProviderRequestError(
      502,
      error instanceof Error ? `failed to fetch fileUrl: ${error.message}` : "failed to fetch fileUrl",
    );
  } finally {
    timeout.cleanup();
  }
}

async function uploadSlackFileContent(
  uploadUrl: string,
  filename: string,
  content: Uint8Array,
  mimeType: string | undefined,
  context: SlackActionContext,
): Promise<void> {
  const bytes = new Uint8Array(content);
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const response = await context.fetcher(uploadUrl, {
    method: "POST",
    headers: {
      "content-type": mimeType ?? "application/octet-stream",
    },
    body,
    signal: context.signal,
  });
  if (response.ok) {
    return;
  }

  const message =
    (await response.text().catch(() => "")) || `slack file upload failed with ${response.status}: ${filename}`;
  throw new ProviderRequestError(response.status, message);
}

function normalizeNextCursor(cursor: string | undefined): string | null {
  return cursor ? cursor : null;
}

function readSlackScopes(value: unknown): string[] {
  return (optionalString(value) ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function readSlackTokenKind(accessToken: string, metadata: Record<string, unknown>): SlackOAuthTokenKind | undefined {
  const rawTokenType = metadata.rawTokenType;
  if (rawTokenType == "bot") {
    return "bot";
  }
  if (rawTokenType == "user") {
    return "user";
  }
  if (accessToken.startsWith("xoxb-")) {
    return "bot";
  }
  if (accessToken.startsWith("xoxp-")) {
    return "user";
  }
  return undefined;
}

function readSlackCredentialScopes(accessToken: string, metadata: Record<string, unknown>): string[] {
  switch (readSlackTokenKind(accessToken, metadata)) {
    case "user":
      return uniqueSlackScopes(readSlackScopes(optionalRecord(metadata.authed_user)?.scope ?? metadata.scope));
    case "bot":
      return uniqueSlackScopes(readSlackScopes(metadata.scope));
    default:
      return [];
  }
}

function uniqueSlackScopes(scopes: string[]): string[] {
  return [...new Set(scopes)];
}

function normalizeScheduledPostAt(value: number | string | undefined, fallback: number): number {
  if (value == null) {
    return fallback;
  }
  const postAt = Number(value);
  if (!Number.isInteger(postAt)) {
    throw new ProviderRequestError(502, "slack schedule_message response is invalid: post_at");
  }
  return postAt;
}

function normalizeListedConversation(value: unknown): Record<string, unknown> {
  const channel = optionalRecord(value);
  if (!channel || typeof channel.id !== "string" || !channel.id || channel.id.trim() !== channel.id) {
    throw slackResponseError("conversations.list channel id");
  }
  for (const field of ["is_im", "is_mpim", "is_private", "is_channel", "is_group"]) {
    if (channel[field] !== undefined && typeof channel[field] !== "boolean") {
      throw slackResponseError(`conversations.list ${field}`);
    }
  }
  // Positive IM/MPIM/channel flags establish kind even when unrelated negative
  // flags are absent. Privacy is required only to distinguish modern channels.
  if (channel.is_im === true || channel.is_mpim === true) {
    if (
      (channel.is_im === true && (channel.is_mpim === true || channel.is_group === true)) ||
      channel.is_channel === true ||
      channel.is_private === false
    ) {
      throw slackResponseError("conversations.list conflicting direct message classification");
    }
  } else if (channel.is_channel === true) {
    if (typeof channel.is_private !== "boolean" || channel.is_group === true) {
      throw slackResponseError("conversations.list channel classification");
    }
  } else if (channel.is_group === true) {
    // Legacy groups and MPIMs can both set is_group. Only is_mpim:false makes
    // this unambiguously a private channel; no negative is_im flag is needed.
    if (channel.is_mpim !== false || channel.is_private === false) {
      throw slackResponseError("conversations.list ambiguous group classification");
    }
  } else {
    throw slackResponseError("conversations.list channel classification");
  }
  return normalizeConversation(channel);
}

function normalizeConversationType(conversation: Record<string, unknown>): SlackNormalizedConversationType {
  if (conversation.is_im === true) {
    return "im";
  }
  if (conversation.is_mpim === true) {
    return "mpim";
  }
  if (conversation.is_private === true || conversation.is_group === true) {
    return "private_channel";
  }
  if (conversation.is_channel === true) {
    return "public_channel";
  }
  return "unknown";
}

function normalizeConversation(conversation: Record<string, unknown>): Record<string, unknown> {
  const topic = optionalRecord(conversation.topic);
  const purpose = optionalRecord(conversation.purpose);

  return compactObject({
    channelId: String(conversation.id ?? ""),
    name: typeof conversation.name === "string" ? conversation.name : null,
    type: normalizeConversationType(conversation),
    isArchived: typeof conversation.is_archived === "boolean" ? conversation.is_archived : null,
    isPrivate: typeof conversation.is_private === "boolean" ? conversation.is_private : null,
    isMember: typeof conversation.is_member === "boolean" ? conversation.is_member : null,
    memberCount: typeof conversation.num_members === "number" ? conversation.num_members : undefined,
    topic: typeof topic?.value === "string" ? topic.value : null,
    purpose: typeof purpose?.value === "string" ? purpose.value : null,
    userId: optionalString(conversation.user),
    locale: optionalString(conversation.locale),
  });
}

function normalizeSearchMessageMatch(match: Record<string, unknown>): Record<string, unknown> {
  const channel = optionalRecord(match.channel) ?? {};

  return compactObject({
    matchId: optionalString(match.iid),
    channelId: optionalString(channel.id),
    channelName: typeof channel.name === "string" ? channel.name : null,
    ts: optionalString(match.ts),
    userId: optionalString(match.user),
    username: optionalString(match.username),
    text: typeof match.text === "string" ? match.text : "",
    permalink: optionalString(match.permalink),
    teamId: optionalString(match.team),
    type: optionalString(match.type),
  });
}

function normalizeUser(user: Record<string, unknown>): Record<string, unknown> {
  const profile = optionalRecord(user.profile) ?? {};

  return compactObject({
    userId: String(user.id ?? ""),
    username: typeof user.name === "string" ? user.name : null,
    realName: typeof profile.real_name === "string" ? profile.real_name : null,
    displayName: typeof profile.display_name === "string" ? profile.display_name : null,
    isBot: typeof user.is_bot === "boolean" ? user.is_bot : null,
    isDeleted: typeof user.deleted === "boolean" ? user.deleted : null,
    isAdmin: typeof user.is_admin === "boolean" ? user.is_admin : null,
    isOwner: typeof user.is_owner === "boolean" ? user.is_owner : null,
    locale: optionalString(user.locale),
  });
}

function normalizeFile(file: Record<string, unknown>): Record<string, unknown> {
  return compactObject({
    ...file,
    fileId: optionalString(file.id),
    name: optionalString(file.name),
    title: optionalString(file.title),
    mimetype: optionalString(file.mimetype),
    urlPrivate: optionalString(file.url_private),
  });
}

function slackApiUrl(method: string): URL {
  return new URL(`${slackApiBaseUrl}/${method}`);
}

function slackHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "user-agent": providerUserAgent,
  };
}

function assertSlackPayload(payload: SlackPayloadError): void {
  if (payload.ok !== false) {
    return;
  }

  const message = formatSlackPayloadError(payload);
  switch (payload.error) {
    case "not_authed":
    case "invalid_auth":
    case "token_revoked":
      throw new ProviderRequestError(401, message, payload);
    case "ratelimited":
    case "rate_limited":
      throw new ProviderRequestError(429, message, payload);
    default:
      throw new ProviderRequestError(400, message, payload);
  }
}

function formatSlackPayloadError(payload: SlackPayloadError): string {
  const error = payload.error ?? "unknown slack error";
  const messages = payload.response_metadata?.messages;
  if (!Array.isArray(messages)) {
    return error;
  }

  const details = messages.filter((message) => typeof message === "string");
  if (details.length === 0) {
    return error;
  }

  return `${error}: ${details.join("; ")}`;
}

function slackHttpError(status: number, payload: SlackPayloadError, retryAfter: string | null): ProviderRequestError {
  const message = payload.error ? formatSlackPayloadError(payload) : `slack request failed with ${status}`;
  if (status === 429 && retryAfter !== null && /^\d+$/.test(retryAfter)) {
    const retryAfterSeconds = Number(retryAfter);
    if (Number.isSafeInteger(retryAfterSeconds)) {
      // The action envelope carries provider details; retain pacing so callers
      // can resume the same page without guessing when this workspace may retry.
      return new ProviderRequestError(status, message, { ...payload, retryAfterSeconds });
    }
  }
  return new ProviderRequestError(status, message, payload);
}

function slackResponseError(message: string): ProviderRequestError {
  return new ProviderRequestError(502, `slack response is invalid: ${message}`);
}

function assertFetchableFileUrl(value: string): void {
  assertPublicHttpUrl(value, {
    fieldName: "fileUrl",
    createError: (message) => new ProviderRequestError(400, message),
  });
}
