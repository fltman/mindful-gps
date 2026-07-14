/**
 * Anslutningen till Postgres, och schemat.
 *
 * Ingen ORM. Frågorna står i queries.ts och är typade för hand — SQL:en i den här
 * kodbasen är kort nog att läsas, och en ORM hade bara gömt PostGIS-anropen.
 */

import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgres://mindful:mindful@localhost:5435/mindful';

export const pool = new Pool({ connectionString: DATABASE_URL });

/**
 * Lägg på schemat. Idempotent: schema.sql består av CREATE ... IF NOT EXISTS och
 * beskriver hur databasen ska se ut, inte vad som ska ändras. Körs vid varje uppstart.
 */
export async function migrate(): Promise<void> {
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

/** Kör `fn` i en transaktion. Rullar tillbaka vid fel och lämnar alltid tillbaka klienten. */
export async function inTransaction<T>(
  fn: (tx: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (err) {
    await tx.query('ROLLBACK');
    throw err;
  } finally {
    tx.release();
  }
}
