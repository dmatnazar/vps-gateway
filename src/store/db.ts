/**
 * Database abstraction module for VPS Gateway.
 * Re-exports SQLite DB instance and helper methods from sqliteDb.ts.
 */
export { getDb, logSync, getSyncLogs, closeDb } from './sqliteDb';
