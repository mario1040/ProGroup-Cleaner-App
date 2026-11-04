import "dotenv/config";
import { Pool } from "pg";
import { generateRecurringTasksForDate } from "./task-generator";

function getBusinessDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.APP_TIME_ZONE || "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return String(values.year) + "-" + String(values.month) + "-" + String(values.day);
}

async function main(): Promise<void> {
  const date = process.argv[2] || getBusinessDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Date must use YYYY-MM-DD format.");
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required.");
  }

  const pool = new Pool({ connectionString });
  try {
    const summary = await generateRecurringTasksForDate(pool, date);
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    "Task generation failed: " +
      (error instanceof Error ? error.message : "Unknown error") +
      "\n",
  );
  process.exitCode = 1;
});
