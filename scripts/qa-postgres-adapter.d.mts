import type pg from "pg";

/** Pool for the dedicated loopback kip_qa_ database named by the PG* variables. */
export const pool: pg.Pool;
/** Connection URL for that database; the Neon driver is routed to it. */
export const dbUrl: string;
export function applyMigration(path: string): Promise<void>;
