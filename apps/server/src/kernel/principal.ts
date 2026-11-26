import type { Kysely } from 'kysely';
import type { Role } from '@neurouter/shared';
import type { MainDB } from './db/schema.js';
import { parseJsonColumn } from './lib/json.js';

/** A signed-in console user (roles admin | viewer, A28). Anonymous = demo-mode viewer session. */
export interface ConsoleUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: 'active' | 'disabled';
  anonymous: boolean;
  preferences: Record<string, unknown>;
}

export async function loadConsoleUser(db: Kysely<MainDB>, userId: string, anonymous = false): Promise<ConsoleUser | null> {
  const u = await db.selectFrom('users').selectAll().where('id', '=', userId).executeTakeFirst();
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, anonymous, preferences: parseJsonColumn<Record<string, unknown>>(u.preferences) ?? {} };
}

export const isAdmin = (u: Pick<ConsoleUser, 'role' | 'anonymous'>): boolean => u.role === 'admin' && !u.anonymous;
