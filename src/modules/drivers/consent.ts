import { Op } from 'sequelize';

import { NotFoundError } from '../../shared/errors';
import * as audit from '../audit/audit.service';
import { CampaignVehicle, LIVE_ASSIGNMENT } from '../installations/installations.model';
import * as installations from '../installations/installations.service';
import * as notifications from '../notifications/notifications.service';
import * as tracking from '../tracking/tracking.service';

import { Driver, DriverConsent, type ConsentAction } from './drivers.model';

/**
 * Location-tracking consent — AC-04.3 to AC-04.6.
 *
 * This lives outside `drivers.service` because withdrawing consent is not a
 * field edit. AC-04.5 gives it two consequences that reach into other modules:
 * tracking stops, and the driver comes off their live campaigns. Putting it in
 * the driver service would mean that service importing installations, which
 * already imports tracking, which reads the driver's eligibility.
 */

/**
 * The wording the driver agreed to. Bump this whenever the disclosure changes,
 * because a consent record that cannot name what was disclosed is not evidence
 * that anything was disclosed (AC-04.4).
 */
export const CONSENT_POLICY_VERSION = '2026-08-31';

/**
 * What the app must show above the control, and what an auditor is entitled to
 * see verbatim. Served from here rather than hardcoded in the client so the
 * text the driver read and the version recorded against it cannot drift.
 */
export const CONSENT_DISCLOSURE = {
  version: CONSENT_POLICY_VERSION,
  title: 'Location tracking',
  summary:
    'MoveAd records where your vehicle goes while you are tracking a campaign. This is how a verified kilometre is proved, and it is the only reason you are paid.',
  points: [
    {
      heading: 'What is collected',
      body: 'Your position, speed, direction and the accuracy of each reading, roughly every few seconds.',
    },
    {
      heading: 'When it is collected',
      body: 'Only while you have started a tracking session for a live campaign. Never when tracking is stopped, and never on a day you do not drive for MoveAd.',
    },
    {
      heading: 'Why it is collected',
      body: 'To measure the distance you drove and which pricing zone you drove it in. Nothing else decides what you earn.',
    },
    {
      heading: 'Who can see it',
      body: 'MoveAd operations, for billing and for checking disputed journeys. Advertisers are shown distance and zones, never your name or your home.',
    },
    {
      heading: 'You can withdraw it',
      body: 'At any time, from this screen. Tracking stops immediately and you are taken off any live campaign. Kilometres you already earned are still paid.',
    },
  ],
} as const;

export interface ConsentRecord {
  granted: boolean;
  recordedAt: string | null;
  policyVersion: string | null;
}

export interface WithdrawalEffects {
  /** True when a session was running and this ended it. */
  trackingStopped: boolean;
  /** Live assignments the driver was taken off (AC-04.5). */
  campaignsReleased: number;
}

export async function current(driverId: string): Promise<ConsentRecord> {
  const latest = await latestFor(driverId);
  if (!latest) return { granted: false, recordedAt: null, policyVersion: null };

  return {
    granted: latest.action === 'GRANTED',
    recordedAt: latest.recordedAt.toISOString(),
    policyVersion: latest.policyVersion,
  };
}

/** The whole history, newest first. AC-04.3's "recorded and timestamped". */
export async function history(driverId: string): Promise<ConsentRecord[]> {
  const rows = await DriverConsent.findAll({
    where: { driverId, kind: 'LOCATION_TRACKING' },
    order: [['recordedAt', 'DESC']],
  });

  return rows.map((row) => ({
    granted: row.action === 'GRANTED',
    recordedAt: row.recordedAt.toISOString(),
    policyVersion: row.policyVersion,
  }));
}

/** Who is answering. Always the driver themselves — this is not an admin action. */
export interface ConsentActor {
  driverId: string;
  actorUserId: string;
  ip: string | null;
}

export async function grant(input: ConsentActor): Promise<ConsentRecord> {
  await record(input.driverId, 'GRANTED', input);
  return current(input.driverId);
}

/**
 * AC-04.5 — withdrawal is not a preference, it is a stop.
 *
 * The order matters. Tracking ends first so no further kilometre can be
 * measured while the assignments are being released; releasing first would
 * leave a live session pointing at an assignment that no longer exists.
 *
 * Kilometres already earned are deliberately left alone. Consent covered the
 * collection at the time it happened, withdrawing it is not retrospective, and
 * deleting a driver's earnings because they asked to stop being followed would
 * be a penalty dressed up as a privacy control.
 */
export async function withdraw(input: ConsentActor): Promise<ConsentRecord & WithdrawalEffects> {
  await record(input.driverId, 'WITHDRAWN', input);

  const trackingStopped = await stopAnyLiveSession(input.driverId);
  const campaignsReleased = await releaseLiveAssignments(input);

  if (campaignsReleased > 0 || trackingStopped) {
    await notifications.notifyDriver({
      driverId: input.driverId,
      kind: 'CAMPAIGN',
      title: 'Location tracking turned off',
      body: campaignsReleased
        ? 'You have been taken off your campaign because tracking is off. Turn it back on in Settings and operations can assign you again.'
        : 'Tracking has stopped. Turn it back on in Settings when you are ready to earn again.',
      href: '/settings',
    });
  }

  return { ...(await current(input.driverId)), trackingStopped, campaignsReleased };
}

async function stopAnyLiveSession(driverId: string): Promise<boolean> {
  try {
    await tracking.stopSession({ driverId, reason: 'The driver withdrew location consent.' });
    return true;
  } catch (error) {
    // Nothing running is the ordinary case, not a failure.
    if (error instanceof NotFoundError) return false;
    throw error;
  }
}

async function releaseLiveAssignments(input: ConsentActor): Promise<number> {
  const live = await CampaignVehicle.findAll({
    where: { driverId: input.driverId, status: { [Op.in]: LIVE_ASSIGNMENT } },
  });

  for (const assignment of live) {
    await installations.unassign({
      assignmentId: assignment.id,
      reason: 'The driver withdrew consent for location tracking (AC-04.5).',
      actor: { userId: input.actorUserId, ip: input.ip },
    });
  }

  return live.length;
}

async function record(
  driverId: string,
  action: ConsentAction,
  actor: { actorUserId: string; ip: string | null },
): Promise<void> {
  const driver = await Driver.findByPk(driverId);
  if (!driver) throw new NotFoundError('Driver');

  await DriverConsent.create({
    driverId,
    kind: 'LOCATION_TRACKING',
    action,
    policyVersion: CONSENT_POLICY_VERSION,
    source: 'mobile',
    ip: actor.ip,
  });

  await audit.record({
    action: action === 'GRANTED' ? 'driver.consent_granted' : 'driver.consent_withdrawn',
    entityType: 'driver',
    entityId: driverId,
    after: { kind: 'LOCATION_TRACKING', action, policyVersion: CONSENT_POLICY_VERSION },
    actorUserId: actor.actorUserId,
    ip: actor.ip,
  });
}

function latestFor(driverId: string): Promise<DriverConsent | null> {
  return DriverConsent.findOne({
    where: { driverId, kind: 'LOCATION_TRACKING' },
    order: [['recordedAt', 'DESC']],
  });
}
