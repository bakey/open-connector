export const oneDriveProviderScopes = {
  userRead: "User.Read",
  filesRead: "Files.Read",
  filesReadWrite: "Files.ReadWrite",
  filesReadAll: "Files.Read.All",
  filesReadWriteAll: "Files.ReadWrite.All",
  offlineAccess: "offline_access",
} as const;

export const oneDriveReadScopes: string[] = [oneDriveProviderScopes.filesRead];
export const oneDriveWriteScopes: string[] = [oneDriveProviderScopes.filesReadWrite];
/**
 * The scopes a client may request for this provider.
 *
 * This list is the ALLOW-LIST `normalizeRequestedScopes` validates
 * `requestedScopes` against, and also the fallback given to a client that
 * requests none. So a scope missing here cannot be asked for at all: the
 * authorization start fails with `requestedScopes contains a scope not
 * declared by one_drive`, before the provider is ever contacted.
 *
 * `Files.Read` is listed alongside `Files.ReadWrite` because this provider
 * already says its read actions need it. Eight of them declare
 * `requiredScopes: oneDriveReadScopes` — `get_drive`, `get_root`, `get_item`,
 * `list_folder_children`, `search_items`, `download_file`,
 * `download_file_by_path`, `download_item_as_format` — and that list is
 * exactly `[Files.Read]`. Leaving it out of the allow-list made the two
 * declarations contradict each other: the scope the actions require was the
 * one scope a client could not ask for.
 *
 * The consequence is a grant wider than anything asks for. A client calling
 * only those eight had to request `Files.ReadWrite` — a consent screen that
 * says the integration may delete the user's files, for an integration that
 * only reads them.
 *
 * Both are declared rather than one replaced. The write actions
 * (`upload_file`, `create_folder`, `update_file_content`, `delete_item`)
 * genuinely need `Files.ReadWrite`, so which to request belongs to the
 * client. A caller that requests nothing still receives the whole list, whose
 * effective access is unchanged — `Files.ReadWrite` already subsumes
 * `Files.Read`.
 */
export const oneDriveOAuthScopes: string[] = [
  oneDriveProviderScopes.userRead,
  oneDriveProviderScopes.filesRead,
  oneDriveProviderScopes.filesReadWrite,
  oneDriveProviderScopes.offlineAccess,
];
