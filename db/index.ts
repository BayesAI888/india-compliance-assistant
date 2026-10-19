export interface DatabaseEnvironment {
  DATABASE_URL?: string;
}

export function requireDatabaseUrl(environment: DatabaseEnvironment) {
  const value = environment.DATABASE_URL?.trim();
  if (!value) {
    throw new Error("DATABASE_URL is not configured. Use a Tencent Cloud PostgreSQL connection string in production.");
  }
  return value;
}
