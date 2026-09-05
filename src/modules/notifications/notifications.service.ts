import { NotFoundError } from '../../shared/errors';
import { loggerFor } from '../../shared/logger';
import { User } from '../identity/identity.model';

import { AppNotification, type NotificationKind } from './notifications.model';

const log = loggerFor('notifications');

export interface NotificationView {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

/**
 * Fan-out to every active staff account. A missing inbox must not fail the
 * action that produced it — the review queue still has the campaign.
 */
export async function notifyStaff(input: {
  kind: NotificationKind;
  title: string;
  body: string;
  href: string;
}): Promise<void> {
  try {
    const staff = await User.findAll({
      where: { advertiserId: null, status: 'ACTIVE' },
      attributes: ['id'],
    });
    if (staff.length === 0) return;

    await AppNotification.bulkCreate(
      staff.map((user) => ({
        userId: user.id,
        driverId: null,
        kind: input.kind,
        title: input.title,
        body: input.body,
        href: input.href,
        readAt: null,
      })),
    );
  } catch (error) {
    log.warn({ err: error, kind: input.kind }, 'Could not write staff notifications');
  }
}

/**
 * Fan-out to every active login on the advertiser account. Same rule as
 * staff: a missed inbox must not roll back approve or reject.
 */
export async function notifyAdvertiserUsers(input: {
  advertiserId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  href: string;
}): Promise<void> {
  try {
    const users = await User.findAll({
      where: { advertiserId: input.advertiserId, status: 'ACTIVE' },
      attributes: ['id'],
    });
    if (users.length === 0) return;

    await AppNotification.bulkCreate(
      users.map((user) => ({
        userId: user.id,
        driverId: null,
        kind: input.kind,
        title: input.title,
        body: input.body,
        href: input.href,
        readAt: null,
      })),
    );
  } catch (error) {
    log.warn(
      { err: error, kind: input.kind, advertiserId: input.advertiserId },
      'Could not write advertiser notifications',
    );
  }
}

/**
 * The driver's own inbox. Addressed to the driver rather than to their web
 * login, because the mobile app is the primary client and a driver may have no
 * `users` row yet — the table's check constraint takes one or the other.
 */
export async function notifyDriver(input: {
  driverId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  href: string;
}): Promise<void> {
  await notifyDrivers({ ...input, driverIds: [input.driverId] });
}

/**
 * The same message to every driver carrying a campaign.
 *
 * One insert rather than one per driver, because this runs inside an admin
 * action that a person is waiting on, and a campaign can have eighty vehicles.
 */
export async function notifyDrivers(input: {
  driverIds: string[];
  kind: NotificationKind;
  title: string;
  body: string;
  href: string;
}): Promise<void> {
  const unique = [...new Set(input.driverIds)];
  if (unique.length === 0) return;

  try {
    await AppNotification.bulkCreate(
      unique.map((driverId) => ({
        userId: null,
        driverId,
        kind: input.kind,
        title: input.title,
        body: input.body,
        href: input.href,
        readAt: null,
      })),
    );
  } catch (error) {
    log.warn(
      { err: error, kind: input.kind, drivers: unique.length },
      'Could not write driver notifications',
    );
  }
}

/**
 * Whose inbox this is.
 *
 * A driver's rows are addressed by `driver_id` and a staff or advertiser
 * user's by `user_id` — the table takes one or the other and never both. The
 * read side has to make the same distinction, or a driver signing in on the
 * phone reads an inbox scoped to a `users` row they may not even have. That
 * was the state of it: `notifyDriver` wrote rows nothing could then read.
 */
export type InboxOwner = { userId: string } | { driverId: string };

export async function listFor(
  owner: InboxOwner,
  limit: number,
): Promise<{ items: NotificationView[]; unreadCount: number }> {
  const [rows, unreadCount] = await Promise.all([
    AppNotification.findAll({
      where: owner,
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit,
    }),
    AppNotification.count({ where: { ...owner, readAt: null } }),
  ]);

  return { items: rows.map(toView), unreadCount };
}

export async function markRead(owner: InboxOwner, id: string): Promise<NotificationView> {
  const row = await AppNotification.findOne({ where: { id, ...owner } });
  if (!row) throw new NotFoundError('Notification');
  if (!row.readAt) {
    await row.update({ readAt: new Date() });
  }
  return toView(row);
}

export async function markAllRead(owner: InboxOwner): Promise<{ unreadCount: number }> {
  await AppNotification.update({ readAt: new Date() }, { where: { ...owner, readAt: null } });
  return { unreadCount: 0 };
}

function toView(row: AppNotification): NotificationView {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    href: row.href,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
