// Position sizes you're allowed: the base ladder, FUNDED adds 10 and 25 lots,
// and a RIDE balance adds one lot per $10,000 of ride on top of your largest size.
export const BASE_SIZES = [1, 2, 5];
export const FUNDED_SIZES = [1, 2, 5, 10, 25];
export const RIDE_PER_LOT = 10_000;

export function sizesFor(progress) {
  const sizes = progress.funded ? [...FUNDED_SIZES] : [...BASE_SIZES];
  const top = sizes[sizes.length - 1];
  const rideLots = progress.ride?.active ? Math.floor(progress.ride.balance / RIDE_PER_LOT) : 0;
  if (rideLots > 0) sizes.push(top + rideLots);
  return { sizes, maxLots: Math.max(10, top) + rideLots, rideLots };
}
