import { describe, expect, it } from "vitest";
import { provider } from "./definition.ts";
import { oneDriveProviderScopes } from "./scopes.ts";

function oauth() {
  const auth = provider.auth.find((candidate) => candidate.type === "oauth2");
  expect(auth, "one_drive must keep an oauth2 auth method").toBeDefined();
  return auth!;
}

describe("OneDrive provider definition", () => {
  /**
   * A read-only client must be able to ask for read-only access.
   *
   * `auth.scopes` is the allow-list `normalizeRequestedScopes` checks
   * `requestedScopes` against, so dropping `Files.Read` from it does not
   * merely change a default — it makes the scope unrequestable, and every
   * read-only integration's authorization start fails with
   * `requestedScopes contains a scope not declared by one_drive`. The
   * narrowest grant available would become full read/write.
   */
  it("declares Files.Read so a read-only client can request it", () => {
    expect(oauth().scopes).toContain(oneDriveProviderScopes.filesRead);
  });

  /**
   * And the write scope stays, because the write actions need it — the point
   * is that the client chooses, not that read replaces write.
   */
  it("still declares Files.ReadWrite for the write actions", () => {
    expect(oauth().scopes).toContain(oneDriveProviderScopes.filesReadWrite);
  });

  it("declares the identity and refresh scopes the flow depends on", () => {
    expect(oauth().scopes).toContain(oneDriveProviderScopes.userRead);
    expect(oauth().scopes).toContain(oneDriveProviderScopes.offlineAccess);
  });

  /**
   * No `.All` scope is declared. Those are tenant-wide — they read every
   * user's files, not the signing-in user's — and nothing in this provider
   * needs one. Declaring one would make it requestable, and an admin-consent
   * prompt is not something a client should be able to trigger by accident.
   */
  it("declares no tenant-wide scope", () => {
    expect(oauth().scopes).not.toContain(oneDriveProviderScopes.filesReadAll);
    expect(oauth().scopes).not.toContain(oneDriveProviderScopes.filesReadWriteAll);
  });
});
