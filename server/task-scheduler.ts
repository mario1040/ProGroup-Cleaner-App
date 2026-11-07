/**
 * Daily task generation is enabled by default after the PostgreSQL cutover.
 * Operators can explicitly pause it with TASK_GENERATION_ENABLED=false.
 * Invalid values fail closed so a typo cannot unexpectedly start generation.
 */
export function isTaskGenerationEnabled(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return true;
  return value.trim().toLowerCase() === "true";
}
