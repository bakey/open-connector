import type { ExecutionContext, ResolvedCredential, TransitFileStore } from "../../core/types.ts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAction } from "../../core/execution.ts";
import { setDefaultGuardedFetchDnsLookup } from "../../core/guarded-fetch.ts";
import { provider } from "./definition.ts";
import { executors } from "./executors.ts";

interface CapturedRequest {
  url: URL;
  authorization: string | null;
  signal: AbortSignal | null;
}

const oauthCredential: Extract<ResolvedCredential, { authType: "oauth2" }> = {
  authType: "oauth2",
  accessToken: "onedrive-access-token",
  tokenType: "Bearer",
  profile: { accountId: "onedrive:test", displayName: "OneDrive test", grantedScopes: [] },
  metadata: {},
};

beforeEach(() => {
  setDefaultGuardedFetchDnsLookup(null);
});

afterEach(() => {
  setDefaultGuardedFetchDnsLookup(undefined);
  vi.unstubAllGlobals();
});

/// **The published catalog must NAME what the wire was measured to carry.**
///
/// Raised in review (coderabbitai on oomol-lab#563) and correct: `looseObject`
/// lets an undeclared key through at runtime, but it does not put that key in
/// the schema's `properties` — so a consumer generating types from the catalog
/// cannot see it. The fixtures below already recorded the gap in prose
/// ("neither of which any schema here names"); this closes it and pins it.
///
/// Asserted on the ACTION's own output schema rather than on a returned row,
/// because that is the artefact an SDK consumer reads, and the tests that
/// exercise the return path pass whether or not these are declared — the
/// fixture comments say so explicitly.
///
/// Every one of these was observed on a real personal drive. None is
/// required: `looseObject` emits no `required` list, so declaring them says
/// "may appear", which is what was measured.
describe("list_item_permissions declares the fields it was measured to return", () => {
  const action = provider.actions.find((candidate) => candidate.name === "list_item_permissions")!;
  const permission = (action.outputSchema as Record<string, any>).properties.items.items;

  it("names the identity fields a caller can actually key on", () => {
    for (const set of ["grantedTo", "grantedToV2"]) {
      const arm = permission.properties[set].properties;
      // `siteUser` is where the measured personal-drive grant put them, and
      // `user` is where a business drive does.
      for (const who of Object.keys(arm)) {
        expect(Object.keys(arm[who].properties)).toEqual(
          expect.arrayContaining(["id", "displayName", "email", "loginName"]),
        );
      }
    }
  });

  it("names the reference fields inheritedFrom was measured to carry", () => {
    const reference = permission.properties.inheritedFrom.properties;
    expect(Object.keys(reference)).toEqual(
      expect.arrayContaining(["driveId", "id", "path", "shareId", "sharepointIds"]),
    );
  });

  it("declares none of them required, because each was absent somewhere", () => {
    const identity = permission.properties.grantedToV2.properties.siteUser;
    expect(identity.required ?? []).toEqual([]);
    expect(permission.properties.inheritedFrom.required ?? []).toEqual([]);
  });
});

describe("OneDrive transit downloads", () => {
  it("follows the guarded content redirect and stores exact file bytes", async () => {
    const content = new Uint8Array([79, 110, 101, 0, 255]);
    const requests = stubResponses([
      Response.json({
        id: "item-1",
        name: "notes.txt",
        size: content.length,
        file: { mimeType: "text/plain" },
      }),
      new Response(null, {
        status: 302,
        headers: { location: "https://public.dm.files.1drv.com/download/item-1" },
      }),
      new Response(Uint8Array.from(content), { headers: { "content-type": "text/plain; charset=utf-8" } }),
    ]);
    const { store, create } = createTransitFileStore(1024);
    const controller = new AbortController();

    const result = await executeOneDriveAction("download_file", { itemId: "item-1" }, store, controller.signal);

    expect(result).toEqual({
      ok: true,
      output: {
        fileId: "item-1",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: content.length,
        file: {
          fileId: "transit-file-1",
          downloadUrl: "http://localhost/api/files/transit-file-1",
          sizeBytes: content.length,
          name: "notes.txt",
          mimeType: "text/plain",
        },
      },
    });
    expect(requests).toHaveLength(3);
    expect(requests[0]?.url.pathname).toBe("/v1.0/me/drive/items/item-1");
    expect(requests[0]?.url.searchParams.get("$select")).toBe("id,name,size,file,folder");
    expect(requests[1]?.url.pathname).toBe("/v1.0/me/drive/items/item-1/content");
    expect(requests[0]?.authorization).toBe("Bearer onedrive-access-token");
    expect(requests[1]?.authorization).toBe("Bearer onedrive-access-token");
    expect(requests[2]?.authorization).toBeNull();
    expect(requests[0]?.signal).toBe(controller.signal);
    expect(requests[1]?.signal).toBe(controller.signal);
    expect(create).toHaveBeenCalledOnce();
    expect(new Uint8Array(await create.mock.calls[0]![0].arrayBuffer())).toEqual(content);
  });

  it("stores converted content with the converted extension and MIME type", async () => {
    const content = new Uint8Array([37, 80, 68, 70]);
    const requests = stubResponses([
      Response.json({
        id: "item-2",
        name: "proposal.docx",
        size: 10_000,
        file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      }),
      new Response(Uint8Array.from(content), { headers: { "content-type": "application/octet-stream" } }),
    ]);
    const { store } = createTransitFileStore(16);

    const result = await executeOneDriveAction("download_item_as_format", { itemId: "item-2", format: "pdf" }, store);

    expect(result).toMatchObject({
      ok: true,
      output: {
        fileId: "item-2",
        name: "proposal.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        file: { name: "proposal.pdf", mimeType: "application/pdf", sizeBytes: content.length },
      },
    });
    expect(requests[1]?.url.searchParams.get("format")).toBe("pdf");
  });

  it("supports path-based downloads with the same transit result", async () => {
    const requests = stubResponses([
      Response.json({ id: "item-3", name: "report.csv", size: 2, file: { mimeType: "text/csv" } }),
      new Response("ok", { headers: { "content-type": "text/csv" } }),
    ]);
    const { store } = createTransitFileStore(16);

    const result = await executeOneDriveAction(
      "download_file_by_path",
      { itemPath: "/reports/report.csv", fileName: "renamed.csv" },
      store,
    );

    expect(result).toMatchObject({
      ok: true,
      output: { fileId: "item-3", name: "report.csv", file: { name: "renamed.csv" } },
    });
    expect(requests[0]?.url.pathname).toBe("/v1.0/me/drive/root:/reports/report.csv:");
    expect(requests[1]?.url.pathname).toBe("/v1.0/me/drive/root:/reports/report.csv:/content");
  });

  it("rejects a reported raw file size above the transit limit before downloading content", async () => {
    const requests = stubResponses([
      Response.json({ id: "item-4", name: "large.bin", size: 3, file: { mimeType: "application/octet-stream" } }),
    ]);
    const { store, create } = createTransitFileStore(2);

    const result = await executeOneDriveAction("download_file", { itemId: "item-4" }, store);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        message: "OneDrive download exceeds 2 bytes",
        details: { status: 413 },
      },
    });
    expect(requests).toHaveLength(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("enforces the transit limit when the response exceeds reported metadata", async () => {
    stubResponses([
      Response.json({ id: "item-5", name: "growing.bin", size: 1, file: { mimeType: "application/octet-stream" } }),
      new Response(Uint8Array.from([1, 2, 3])),
    ]);
    const { store, create } = createTransitFileStore(2);

    const result = await executeOneDriveAction("download_file", { itemId: "item-5" }, store);

    expect(result).toMatchObject({
      ok: false,
      error: { message: "OneDrive download exceeds 2 bytes", details: { status: 413 } },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["download_file", { itemId: "item-1" }],
    ["download_file_by_path", { itemPath: "/notes.txt" }],
    ["download_item_as_format", { itemId: "item-1", format: "pdf" }],
  ] as const)("returns a clear error when %s has no transit storage", async (actionName, input) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const result = await executeOneDriveAction(actionName, input);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        message: "one_drive downloads require local transit file storage",
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("OneDrive item permissions", () => {
  it("reads the permissions of an item by id, and reports the end of the list", async () => {
    const requests = stubResponses([
      Response.json({
        value: [{ id: "perm-1", roles: ["read"], grantedToV2: { user: { id: "u1", displayName: "Ada" } } }],
      }),
    ]);

    const result = await executeOneDriveAction("list_item_permissions", { itemId: "item-1" });

    expect(requests[0]!.url.pathname).toBe("/v1.0/me/drive/items/item-1/permissions");
    expect(result).toEqual({
      ok: true,
      output: {
        items: [{ id: "perm-1", roles: ["read"], grantedToV2: { user: { id: "u1", displayName: "Ada" } } }],
        // Absent `@odata.nextLink` is the end of the list, and it is reported
        // as an explicit null rather than an omitted key: a consumer cannot
        // tell an omitted cursor from a response shape it failed to read.
        nextLink: null,
      },
    });
  });

  it("returns a personal drive's permission unchanged, both spellings included", async () => {
    // Measured: a personal OneDrive returns `grantedTo` and omits
    // `grantedToV2` entirely, while a work or school drive does the opposite.
    //
    // What this pins is the ROUND TRIP — a personal-shaped permission reaches
    // the caller with its attribution intact. It does NOT pin the schema
    // declaration: output schemas are not enforced on the way out, so removing
    // `grantedTo` from `actions.ts` leaves this test green (checked). The
    // declaration earns its place in the published catalog, which is what an
    // SDK consumer reads to learn the field exists at all.
    //
    // The hand-built shape below is the DOCUMENTED one. The measured one is
    // the test after next, and the two disagree — see it.
    stubResponses([
      Response.json({
        value: [
          {
            id: "perm-2",
            roles: ["owner"],
            grantedTo: { user: { id: "u2", displayName: "Grace" } },
            inheritedFrom: { driveId: "d1", id: "parent-1", path: "/drive/root:" },
          },
        ],
      }),
    ]);

    const result = await executeOneDriveAction("list_item_permissions", { itemId: "item-2" });

    expect(result).toMatchObject({
      ok: true,
      output: {
        items: [
          {
            grantedTo: { user: { id: "u2", displayName: "Grace" } },
            // `inheritedFrom` is personal-only and is the difference between
            // "shared here" and "shared above"; dropping it would make a
            // folder's own sharing indistinguishable from its parent's.
            inheritedFrom: { id: "parent-1" },
          },
        ],
      },
    });
  });

  it("returns a real personal-drive owner permission verbatim, siteUser and all", async () => {
    // **The measured shape**, from one real personal OneDrive on 2026-09-17
    // (the address is redacted; nothing else is changed). It is here because
    // every part of it contradicts what the documented resource suggests:
    //
    //   * `grantedToV2` IS present on a personal drive — the deprecated
    //     `grantedTo` is not a substitute for it, both arrive — but it carries
    //     `siteUser`, NOT `user`. A consumer reading `grantedToV2.user` finds
    //     nothing and silently falls through.
    //   * `user.id` is `"4"`. That is a SharePoint site-local user index, not
    //     a directory object id: `loginName` is the claims encoding that says
    //     so, and the drive's own `createdBy.user.id` on the same account is
    //     the 16-hex CID instead. Two id spaces, one drive, two endpoints.
    //   * the only identifier that is the same person anywhere else is the
    //     EMAIL, which also appears inside `loginName` and, base64url-encoded,
    //     as `id` and `shareId`.
    //
    // This action returns all of it and decides none of it. Which field a
    // consumer keys on is a consumer's decision, and it cannot make a good one
    // against a shape it never sees.
    //
    // What this test pins is the RETURN PATH: `readCollectionItems` hands the
    // page's items back untouched, including fields no schema names —
    // `siteUser.email` and `siteUser.loginName` are not in `identity`, and
    // they arrive anyway. It does NOT pin the schema declarations: output
    // schemas are not enforced on the way out here, and making either
    // `permission` or `identity` strict (`s.object`, `additionalProperties:
    // false`) leaves every test in this file green (checked). The declarations
    // are the PUBLISHED CATALOG's contract — what an SDK consumer generates
    // types from — not a runtime guard, and reading them as one is the wrong
    // assumption to inherit from this file.
    stubResponses([
      Response.json({
        value: [
          {
            id: "aTowIy5mfG1lbWJlcnNoaXB8c29tZW9uZUBleGFtcGxlLmNvbQ",
            roles: ["owner"],
            shareId: "aTowIy5mfG1lbWJlcnNoaXB8c29tZW9uZUBleGFtcGxlLmNvbQ",
            grantedToV2: {
              siteUser: {
                displayName: "Example Owner",
                email: "someone@example.com",
                id: "4",
                loginName: "i:0#.f|membership|someone@example.com",
              },
            },
            grantedTo: {
              user: { displayName: "Example Owner", email: "someone@example.com", id: "4" },
            },
            link: { webUrl: "https://1drv.ms/f/c/EXAMPLECID/AsExampleShareToken" },
          },
        ],
      }),
    ]);

    const result = await executeOneDriveAction("list_item_permissions", { itemId: "item-owner" });

    expect(result).toEqual({
      ok: true,
      output: {
        items: [
          {
            id: "aTowIy5mfG1lbWJlcnNoaXB8c29tZW9uZUBleGFtcGxlLmNvbQ",
            roles: ["owner"],
            shareId: "aTowIy5mfG1lbWJlcnNoaXB8c29tZW9uZUBleGFtcGxlLmNvbQ",
            grantedToV2: {
              siteUser: {
                displayName: "Example Owner",
                email: "someone@example.com",
                id: "4",
                loginName: "i:0#.f|membership|someone@example.com",
              },
            },
            grantedTo: {
              user: { displayName: "Example Owner", email: "someone@example.com", id: "4" },
            },
            link: { webUrl: "https://1drv.ms/f/c/EXAMPLECID/AsExampleShareToken" },
          },
        ],
        nextLink: null,
      },
    });
  });

  it("keeps a specific-people link's identities, which carry no id at all", async () => {
    // **The measured shape**, 2026-09-17, a specific-people link on a personal
    // drive (address redacted). The first version of this test invented
    // `{ id: "u3", displayName: "Alan" }` — an identity with an id and a human
    // name. The wire sends neither:
    //
    //   * there is **no `id`**. Not a site index, not a GUID, not a CID. A
    //     consumer keying a grantee on an id has nothing to key on.
    //   * `displayName` IS the address, which is the unredeemed-invitation
    //     tell: Microsoft has no account to name yet.
    //   * the member key is **`user`**, while the owner's direct grant in
    //     `grantedToV2` uses **`siteUser`**. Same identity-set type, two
    //     different members, decided by which container it sits in.
    //
    // An invented fixture would have let a consumer build against a field the
    // provider never sends, which is the whole reason this one is measured.
    stubResponses([
      Response.json({
        value: [
          {
            id: "ef759386-fa2e-47db-adff-f9635ef5115b",
            roles: ["read"],
            hasPassword: false,
            grantedToIdentitiesV2: [
              {
                user: {
                  "@odata.type": "#microsoft.graph.sharePointIdentity",
                  displayName: "someone@example.com",
                  email: "someone@example.com",
                },
              },
            ],
            grantedToIdentities: [{ user: { displayName: "someone@example.com", email: "someone@example.com" } }],
            link: { scope: "users", type: "view", preventsDownload: false },
          },
        ],
      }),
    ]);

    const result = await executeOneDriveAction("list_item_permissions", { itemId: "item-3" });

    expect(result).toEqual({
      ok: true,
      output: {
        items: [
          {
            id: "ef759386-fa2e-47db-adff-f9635ef5115b",
            roles: ["read"],
            hasPassword: false,
            grantedToIdentitiesV2: [
              {
                user: {
                  "@odata.type": "#microsoft.graph.sharePointIdentity",
                  displayName: "someone@example.com",
                  email: "someone@example.com",
                },
              },
            ],
            grantedToIdentities: [{ user: { displayName: "someone@example.com", email: "someone@example.com" } }],
            link: { scope: "users", type: "view", preventsDownload: false },
          },
        ],
        nextLink: null,
      },
    });
  });

  it("keeps an inherited grant's inheritedFrom, which is the only thing that says where it came from", async () => {
    // Measured 2026-09-17 on a child of a shared folder (identifiers
    // redacted, shapes intact). This is the entry a consumer needs most and
    // the one most easily lost:
    //
    //   * `inheritedFrom` is PRESENT on a personal drive, and it is the only
    //     field distinguishing "granted on this file" from "granted on an
    //     ancestor". Nothing else in the entry says.
    //   * it is richer than the documented `itemReference` — it carries
    //     `shareId` and a whole `sharepointIds` object, neither of which any
    //     schema here names. They survive because the action returns the page
    //     verbatim.
    //   * the inherited entry carries the SAME `id` and `shareId` as the
    //     folder's own entry, which is the third place a permission id turns
    //     out not to be per-item.
    stubResponses([
      Response.json({
        value: [
          {
            id: "9c7284f8-655c-47f5-8cac-b54b4846300b",
            roles: ["read"],
            hasPassword: false,
            grantedToIdentitiesV2: [{ user: { displayName: "someone@example.com", email: "someone@example.com" } }],
            grantedToIdentities: [{ user: { displayName: "someone@example.com", email: "someone@example.com" } }],
            inheritedFrom: {
              driveId: "EXAMPLECID",
              driveType: "personal",
              id: "EXAMPLECID!s4c54abc634f4204d8071f30f00000000",
              name: "Downloads",
              path: "/drives/EXAMPLECID/root:/Docs/Downloads",
              shareId: "u!aHR0cHM6Ly9leGFtcGxl",
              sharepointIds: {
                listItemId: "4081",
                listItemUniqueId: "4c54abc6-34f4-204d-8071-f30f00000000",
              },
            },
            link: { scope: "users", type: "view", preventsDownload: false },
          },
        ],
      }),
    ]);

    const result = await executeOneDriveAction("list_item_permissions", { itemId: "child-1" });
    const [item] = (result as { output: { items: Record<string, unknown>[] } }).output.items;

    expect(item!.inheritedFrom).toEqual({
      driveId: "EXAMPLECID",
      driveType: "personal",
      id: "EXAMPLECID!s4c54abc634f4204d8071f30f00000000",
      name: "Downloads",
      path: "/drives/EXAMPLECID/root:/Docs/Downloads",
      // Undeclared by `driveItemReference` and returned anyway — the property
      // that makes this action safe to build an admission rule on.
      shareId: "u!aHR0cHM6Ly9leGFtcGxl",
      sharepointIds: {
        listItemId: "4081",
        listItemUniqueId: "4c54abc6-34f4-204d-8071-f30f00000000",
      },
    });
  });

  it("keeps an anonymous link's EMPTY identity arrays, which are present and not absent", async () => {
    // Measured on the same file: OneDrive personal's default share is an
    // anonymous link. The arrays arrive empty rather than missing, so testing
    // for the key is not a test for "somebody is granted" — and there is no
    // `grantedTo` on the entry at all.
    stubResponses([
      Response.json({
        value: [
          {
            id: "10db1af6-12db-4ab8-93b7-acf0aadc5fb8",
            roles: ["read"],
            hasPassword: false,
            grantedToIdentitiesV2: [],
            grantedToIdentities: [],
            link: { scope: "anonymous", type: "view", preventsDownload: false },
          },
        ],
      }),
    ]);

    const result = await executeOneDriveAction("list_item_permissions", { itemId: "item-anon" });

    expect(result).toMatchObject({
      ok: true,
      output: {
        items: [
          {
            grantedToIdentitiesV2: [],
            grantedToIdentities: [],
            link: { scope: "anonymous" },
          },
        ],
      },
    });
    const [item] = (result as { output: { items: Record<string, unknown>[] } }).output.items;
    expect(item, "an anonymous link names nobody").not.toHaveProperty("grantedTo");
    expect(item).not.toHaveProperty("grantedToV2");
  });

  it("addresses an item by path, and a named drive", async () => {
    const byPath = stubResponses([Response.json({ value: [] })]);
    await executeOneDriveAction("list_item_permissions", { itemPath: "/Reports/Q3" });
    expect(byPath[0]!.url.pathname).toBe("/v1.0/me/drive/root:/Reports/Q3:/permissions");

    const byDrive = stubResponses([Response.json({ value: [] })]);
    await executeOneDriveAction("list_item_permissions", { driveId: "drive-9", itemId: "item-4" });
    expect(byDrive[0]!.url.pathname).toBe("/v1.0/drives/drive-9/items/item-4/permissions");
  });

  it("follows a permission nextLink and refuses one that points elsewhere", async () => {
    const followed = stubResponses([Response.json({ value: [{ id: "perm-4", roles: ["read"] }] })]);
    const ok = await executeOneDriveAction("list_item_permissions", {
      itemId: "item-5",
      nextLink: "https://graph.microsoft.com/v1.0/me/drive/items/item-5/permissions?$skiptoken=abc",
    });
    expect(ok).toMatchObject({ ok: true });
    expect(followed[0]!.url.searchParams.get("$skiptoken")).toBe("abc");

    // The cursor is a string Microsoft Graph put in a response body. Following
    // it unchecked would let one response redirect this action at any other
    // endpoint the token can reach — a token minted to read one folder's ACL
    // reading the signed-in user's mail, say.
    //
    // BOTH shapes are refused, and the second is the one that matters. A path
    // outside the drive is caught by `readDrivePathSuffix` returning null, so
    // a test using only that would pass with the endpoint check deleted
    // entirely (checked). The children endpoint is a drive path that reaches
    // the endpoint check, and it is the confusion this policy exists for:
    // three paginated actions share one request builder.
    for (const elsewhere of [
      "https://graph.microsoft.com/v1.0/me/messages",
      "https://graph.microsoft.com/v1.0/me/drive/items/item-5/children",
    ]) {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const refused = await executeOneDriveAction("list_item_permissions", {
        itemId: "item-5",
        nextLink: elsewhere,
      });
      expect(refused, elsewhere).toMatchObject({
        ok: false,
        error: { message: "nextLink must target OneDrive permission pagination endpoints" },
      });
      expect(fetch, elsewhere).not.toHaveBeenCalled();
    }
  });

  it("requires an item to ask about", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const result = await executeOneDriveAction("list_item_permissions", {});

    expect(result).toMatchObject({ ok: false, error: { message: "itemId or itemPath is required" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});

function stubResponses(responses: Response[]): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push({
      url: new URL(request.url),
      authorization: request.headers.get("authorization"),
      signal: init?.signal ?? (input instanceof Request ? input.signal : null),
    });
    const response = responses.shift();
    if (!response) {
      throw new Error(`Unexpected OneDrive request to ${request.url}`);
    }
    return response;
  });
  return requests;
}

function createTransitFileStore(maxBytes: number): {
  store: TransitFileStore;
  create: ReturnType<typeof vi.fn<TransitFileStore["create"]>>;
} {
  const create = vi.fn<TransitFileStore["create"]>(async (file) => ({
    fileId: "transit-file-1",
    downloadUrl: "http://localhost/api/files/transit-file-1",
    sizeBytes: file.size,
    name: file.name,
    mimeType: file.type,
  }));
  return {
    create,
    store: {
      maxBytes,
      create,
      async read() {
        throw new Error("read is not expected in this test");
      },
      async delete() {
        return false;
      },
    },
  };
}

async function executeOneDriveAction(
  actionName: string,
  input: Record<string, unknown>,
  transitFiles?: TransitFileStore,
  signal?: AbortSignal,
) {
  const context: ExecutionContext = {
    getCredential: async (service) => {
      expect(service).toBe("one_drive");
      return oauthCredential;
    },
  };
  if (transitFiles) {
    context.transitFiles = transitFiles;
  }
  if (signal) {
    context.signal = signal;
  }
  return executeAction(
    provider.actions.find((action) => action.name === actionName)!,
    executors[`one_drive.${actionName}`],
    input,
    context,
  );
}
