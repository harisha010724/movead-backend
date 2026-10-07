/**
 * Vehicle kinds and wrap sizes a campaign may book.
 *
 * Kept beside the campaign module so the contract and the row stay aligned.
 * Types are the Indian transit mix; cab wrap names are the Wrapify 180–270–360
 * standard. A dimension that does not belong to the chosen type is refused.
 */

export const VEHICLE_TYPES = ['CAB', 'AUTO', 'BUS', 'TRUCK', 'TEMPO'] as const;

export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const AD_DIMENSIONS: Record<VehicleType, readonly string[]> = {
  AUTO: ['HOOD', 'REAR_HALF', 'REAR_FULL', 'SIDE_PANEL', 'FULL_WRAP'],
  CAB: ['WRAP_180', 'WRAP_270', 'WRAP_360', 'REAR_WINDOW', 'HOOD'],
  BUS: ['SIDE_PANEL', 'BACK_PANEL', 'FULL_WRAP'],
  TRUCK: ['SIDE_PANEL', 'REAR_DOOR', 'FULL_WRAP'],
  TEMPO: ['SIDE_PANEL', 'REAR_DOOR', 'FULL_WRAP'],
};

export function isVehicleType(value: string): value is VehicleType {
  return (VEHICLE_TYPES as readonly string[]).includes(value);
}

export function isAdDimensionFor(type: VehicleType, dimension: string): boolean {
  return AD_DIMENSIONS[type].includes(dimension);
}

export function defaultAdDimension(type: VehicleType): string {
  return AD_DIMENSIONS[type][0] ?? 'FULL_WRAP';
}
