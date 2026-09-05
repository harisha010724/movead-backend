import { QueryTypes, type Transaction } from 'sequelize';

import { sequelize } from '../../db/sequelize';
import { getContext } from '../../shared/context';

/**
 * The append-only trail. AC-32 requires every admin action to be audited and
 * AC-31 requires each one attributable to a named individual.
 *
 * Written with raw SQL and no model on purpose: there is no update path and no
 * delete path, and giving the table a model would invite both. In production
 * the same intent is enforced by `REVOKE UPDATE, DELETE ON audit_log`.
 */

export interface AuditEntry {
  /** Dotted and past tense: `driver.approved`, `payout.released`. */
  action: string;
  entityType: string;
  entityId: string;
  /** Prior state, for anything that changed rather than appeared. */
  before?: unknown;
  after?: unknown;
  /** Omit to attribute to the signed-in actor; pass null for a system action. */
  actorUserId?: string | null;
  ip?: string | null;
}

/**
 * Pass the surrounding transaction whenever the audited change has one. An
 * entry that commits while its change rolls back is worse than no entry,
 * because it reads as evidence that something happened.
 */
export async function record(entry: AuditEntry, transaction?: Transaction): Promise<void> {
  const context = getContext();
  const actorUserId =
    entry.actorUserId !== undefined
      ? entry.actorUserId
      : context?.actor?.kind === 'user'
        ? context.actor.id
        : null;

  await sequelize.query(
    `INSERT INTO audit_log
       (actor_user_id, action, entity_type, entity_id, before, after, request_id, ip)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::inet)`,
    {
      bind: [
        actorUserId,
        entry.action,
        entry.entityType,
        entry.entityId,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        context?.requestId ?? null,
        entry.ip ?? null,
      ],
      type: QueryTypes.INSERT,
      transaction,
    },
  );
}
