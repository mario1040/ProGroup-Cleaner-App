/**
 * Fail closed if a migration/runtime command is pointed at another database.
 * This project must never write into marketing_ops or Evolution's PostgreSQL.
 */
export function assertNarisDatabaseUrl(connectionString: string | undefined): string {
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required.");
  }

  let databaseName: string;
  try {
    const parsed = new URL(connectionString);
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\\/+/, ""));
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }

  if (databaseName !== "naris_ops") {
    throw new Error(
      "Refusing database access: expected database 'naris_ops'. No database connection was opened.",
    );
  }

  return connectionString;
}
