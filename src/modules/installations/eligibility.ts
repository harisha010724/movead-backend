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
 * AC-07's six conditions — its own five plus AC-04.3's consent — evaluated
 * from real rows.
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
     * First, because it is the only one of the six that is a legal
     * precondition rather than an operational one. The others say a kilometre
     * is not owed; this one says it must not be measured at all.
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
    {
      id: 'ad_installed',
      label: 'Advertisement installed',
      passed: installation?.status === 'SUBMITTED' || installation?.status === 'APPROVED',
      remedy: adInstalledRemedy(installation?.status ?? null, installation?.rejectionReason ?? null),
    },
    {
      id: 'installation_verified',
      label: 'Installation verified',
      passed: installation?.status === 'APPROVED',
      remedy:
        installation?.status === 'APPROVED'
          ? null
          : 'Operations is still checking the wrap photos.',
    },
    {
      id: 'campaign_active',
      label: 'Campaign active',
      passed: campaign?.status === 'ACTIVE' && assignment?.status === 'ACTIVE',
      remedy:
        campaign?.status === 'ACTIVE' && assignment?.status === 'ACTIVE'
          ? null
          : 'The campaign has not started running yet.',
    },
  ];

  return { eligible: checks.every((check) => check.passed), checks };
}

/**
 * A passed check carries no remedy — the other four already work that way, and
 * a driver whose wrap is on told to "book your installation appointment" reads
 * it as the system not having noticed.
 */
function adInstalledRemedy(status: string | null, rejectionReason: string | null): string | null {
  if (status === 'SUBMITTED' || status === 'APPROVED') return null;
  if (status === 'REJECTED') return rejectionReason ?? 'The wrap needs to be redone.';
  return 'Book your installation appointment to get the wrap fitted.';
}
