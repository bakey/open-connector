import type { ActionDefinition } from "../../core/types.ts";

import { describe, expect, it } from "vitest";
import { provider } from "./definition.ts";

function action(name: string): ActionDefinition {
  const found = provider.actions.find((candidate) => candidate.name === name);
  expect(found, `${name} must remain in the Feishu catalog`).toBeDefined();
  return found!;
}

describe("Feishu provider definition", () => {
  it("requests the provider-enforced folder-list permission", () => {
    expect(action("list_drive_files").requiredScopes).toEqual(["space:document:retrieve"]);
    expect(action("list_drive_files").providerPermissions).toEqual(["space:document:retrieve"]);
  });

  // The one of the three with no guard until now, and the most consequential:
  // `docs:permission.member:readonly` is refused outright, so
  // `list_drive_permissions` could not be CALLED — every Feishu document ACL
  // read failed at the gate rather than returning something wrong.
  it("requests the provider-enforced permission-member read permission", () => {
    expect(action("list_drive_permissions").requiredScopes).toEqual(["docs:permission.member:retrieve"]);
    expect(action("list_drive_permissions").providerPermissions).toEqual(["docs:permission.member:retrieve"]);
  });

  it("requests the provider-enforced wiki-node read permission", () => {
    expect(action("get_wiki_node").requiredScopes).toEqual(["wiki:node:read"]);
    expect(action("get_wiki_node").providerPermissions).toEqual(["wiki:node:read"]);
  });
});
