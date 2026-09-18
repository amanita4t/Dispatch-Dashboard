export const BACKUP_GUIDANCE = {
  database:
    "Use Neon or your PostgreSQL provider's backup and restore tools, or store a pg_dump export encrypted and access-controlled. Verify retention and test a restore into a separate database before replacing live data. Validate against the original Drive root in read-only mode; independent databases must not both write to it.",
  documents:
    "Google Drive documents are separate from PostgreSQL backups. Recover or back up the original Drive folders and documents separately; a database restore does not recover deleted paperwork.",
  application:
    "This application does not create or restore local database snapshots. Run PostgreSQL backup and recovery tools from a trusted operator environment, not inside a Vercel function.",
} as const;

export const LEGACY_BACKUP_ERROR =
  "In-app database backup and restore endpoints are not supported. Use Neon/provider restore or pg_dump for PostgreSQL, and protect Google Drive documents separately.";

export function legacyBackupUnavailable() {
  return {
    error: LEGACY_BACKUP_ERROR,
    code: "LEGACY_BACKUPS_UNSUPPORTED",
    guidance: BACKUP_GUIDANCE,
  };
}
