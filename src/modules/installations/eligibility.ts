import { Op } from 'sequelize';

import { Campaign } from '../campaigns/campaigns.model';
import { Driver, DriverConsent, Vehicle } from '../drivers/drivers.model';

import { CampaignVehicle, Installation, LIVE_ASSIGNMENT } from './installations.model';

export interface EligibilityCheck {
  id: string;
  label: string;
  passed: boolean;
  remedy: string | null;
}

export interface Eligibility {
  eligible: boolean;
  checks: EligibilityCheck[];
}

/**
 * AC-07's conditions — its own plus AC-04.3's consent — evaluated from real
 * rows.
 *
 * Four checks rather than six. Installed, verified and campaign-active were
 * three ways of asking whether this vehicle is earning today, and a driver
 * blocked on the middle one had no way to tell which of the three people
 * involved they were waiting for. They are now one line, answered by whether
 * operations has put the vehicle on the road.
 *
 * The ids and labels match the mobile app's `TrackingEligibility` exactly, so
 * the same screen renders against either client without a translation layer.
 *
 * This sits in its own module rather than inside the installation service
 * because two callers need it and they need each other: tracking asks whether
 * a kilometre may be billed, and the installation service asks tracking how
 * many kilometres a driver has run. Left where it was, that is an import
 * cycle; the rule is small, self-contained, and reads only models, so it is
 * the piece that moves.
 */
export async function eligibility(driverId: string): Promise<Eligibility> {
  const driver = await Driver.findByPk(driverId);
  const vehicle = await Vehicle.findOne({ where: { driverId } });

  const assignment = await CampaignVehicle.findOne({
    where: { driverId, status: { [Op.in]: LIVE_ASSIGNMENT } },
    include: [{ model: Installation, as: 'installation', required: false }],
  });

  const campaign = assignment ? await Campaign.findByPk(assignment.campaignId) : null;
  const installation = assignment?.installation ?? null;
  const consent = await DriverConsent.findOne({
    where: { driverId, kind: 'LOCATION_TRACKING' },
    order: [['recordedAt', 'DESC']],
  });
  const consented = consent?.action === 'GRANTED';

  const vehicleApproved = Boolean(
    vehicle &&
      ['APPROVED', 'AVAILABLE', 'ASSIGNED', 'INSTALLING', 'ACTIVE'].includes(vehicle.status),
  );
  const driverApproved = driver?.status === 'APPROVED';

  const checks: EligibilityCheck[] = [
    /*
     * First, because it is the only one that is a legal precondition rather
     * than an operational one. The others say a kilometre is not owed; this
     * one says it must not be measured at all.
     */
    {
      id: 'tracking_consent',
      label: 'Location tracking allowed',
      passed: consented,
      remedy: consented ? null : 'Turn on location tracking in Settings to start earning.',
    },
    {
      id: 'vehicle_approved',
      label: 'Vehicle approved',
      passed: vehicleApproved && driverApproved,
      remedy: vehicleApproved && driverApproved ? null : 'Your vehicle is still being verified.',
    },
    {
      id: 'campaign_assigned',
      label: 'Campaign assigned',
      passed: Boolean(assignment),
      remedy: assignment ? null : 'No campaign has been assigned to your vehicle yet.',
    },
    /*
     * One check where there were three, because to a driver they were one
     * question — is my wrap on and am I earning — asked three times.
     *
     * Operations puts the vehicle on the road from the campaign production
     * board, and this follows that decision. The wrap photos (AC-06) are still
     * collected, but as evidence after the fact rather than as the gate: a
     * driver could otherwise sit blocked behind a queue with no screen while
     * the campaign ran without them.
     *
     * A paused or finished campaign still fails here. That is what stops the
     * meter, and removing it would keep paying for kilometres nobody bought.
     */
    {
      id: 'ad_installed',
      label: 'Advertisement installed',
      passed: assignment?.status === 'ACTIVE' && campaign?.status === 'ACTIVE',
      remedy: adInstalledRemedy(
        campaign?.status ?? null,
        assignment?.status ?? null,
        installation?.status ?? null,
        installation?.rejectionReason ?? null,
      ),
    },
  ];

  return { eligible: checks.every((check) => check.passed), checks };
}

/**
 * A passed check carries no remedy — the other three work that way too, and a
 * driver whose wrap is on told to "book your installation appointment" reads
 * it as the system not having noticed.
 *
 * Ordered by what the driver can do about it. A paused campaign is news they
 * can act on by waiting; a wrap that was rejected is work; being assigned to a
 * campaign that has not reached the road yet is neither, and says so plainly
 * rather than implying a missed appointment.
 */
function adInstalledRemedy(
  campaignStatus: string | null,
  assignmentStatus: string | null,
  installationStatus: string | null,
  rejectionReason: string | null,
): string | null {
  if (assignmentStatus === 'ACTIVE' && campaignStatus === 'ACTIVE') return null;

  if (campaignStatus === 'PAUSED') return 'The campaign is paused.';
  if (campaignStatus === 'COMPLETED' || campaignStatus === 'STOPPED') {
    return 'The campaign has finished.';
  }
  if (installationStatus === 'REJECTED') {
    return rejectionReason ?? 'The wrap has to be fitted again.';
  }

  return 'Operations has not fitted your wrap yet. They will be in touch.';
}
