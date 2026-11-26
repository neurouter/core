import type { Kysely } from 'kysely';
import type { CoordinationStore } from '../coordination/types.js';
import type { MainDB } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { newId } from '../lib/ids.js';
import { fromBool, toBool } from '../lib/json.js';
import { BUILTIN_RULES, Redactor, type RedactionRuleDef } from './redact.js';
import type { AuditRecorder } from './recorder.js';

export const REDACTION_CHANNEL = 'redaction.changed';

export interface RedactionRule { id: string; name: string; type: 'key' | 'regex'; pattern: string; replacement: string; enabled: boolean; order: number; builtin: boolean }

type Row = { id: string; name: string; type: 'key' | 'regex'; pattern: string; replacement: string; enabled: 0 | 1; order: number; builtin: 0 | 1 };

const toRule = (r: Row): RedactionRule => ({ id: r.id, name: r.name, type: r.type, pattern: r.pattern, replacement: r.replacement, enabled: toBool(r.enabled), order: Number(r.order), builtin: toBool(r.builtin) });

/** Ordered redaction rules (`redaction_rules`, §9.2) with a compiled Redactor cached across flushes. */
export class RedactionRulesService {
  private cached: Redactor | null = null;

  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    _audit: AuditRecorder,
    private readonly coord?: CoordinationStore,
  ) {
    coord?.subscribe(REDACTION_CHANNEL, () => {
      this.cached = null;
    });
  }

  /** Seeds missing built-ins (first boot, and new built-ins after upgrades). */
  async seedBuiltins(): Promise<number> {
    const existing = new Set((await this.db.selectFrom('redaction_rules').select('name').where('builtin', '=', 1).execute()).map((r) => r.name));
    const now = this.clock.now();
    let added = 0;
    for (const r of BUILTIN_RULES) {
      if (existing.has(r.name)) continue;
      await this.db
        .insertInto('redaction_rules')
        .values({ id: newId(), name: r.name, type: r.type, pattern: r.pattern, replacement: r.replacement, enabled: fromBool(r.enabled), order: r.order, builtin: 1, created_by: null, created_at: now, updated_at: now })
        .execute();
      added++;
    }
    if (added) this.cached = null;
    return added;
  }

  private async rows(): Promise<Row[]> {
    return (await this.db.selectFrom('redaction_rules').select(['id', 'name', 'type', 'pattern', 'replacement', 'enabled', 'order', 'builtin']).orderBy('order').orderBy('name').execute()) as Row[];
  }

  async list(): Promise<{ items: RedactionRule[] }> {
    return { items: (await this.rows()).map(toRule) };
  }

  /** The compiled redactor for the audit writer (built-ins when the table is empty). */
  async redactor(): Promise<Redactor> {
    if (this.cached) return this.cached;
    const rows = await this.rows();
    this.cached = rows.length ? new Redactor(rows.map(toRule) as RedactionRuleDef[]) : Redactor.builtins();
    return this.cached;
  }
}
