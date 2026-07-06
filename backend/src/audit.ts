import { PoolClient } from 'pg';

export type AuditAction = 'create' | 'update' | 'delete' | 'restore' | 'revert';

interface AuditEntry {
  entityId: number;
  action: AuditAction;
  before?: any;
  after?: any;
  note?: string;
  entityType?: string;
}

// Writes one audit_log row. Pass the transaction client so the audit and the
// mutation it describes commit atomically.
export async function recordAudit(client: PoolClient, entry: AuditEntry) {
  const { entityId, action, before, after, note, entityType = 'price_log' } = entry;
  await client.query(
    `INSERT INTO audit_log (entity_type, entity_id, action, before_data, after_data, note)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entityType,
      entityId,
      action,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      note ?? null,
    ]
  );
}
