const GIB = 1073741824n;
const MAX_BIGINT = 9223372036854775807n;

export interface StaticCatalogPrice {
  name: string;
  amountToman: string;
}
export interface StaticCatalogEntry extends StaticCatalogPrice {
  packageBytes: string;
  durationDays: number;
}

/** The Owner's 25 attested shapes, not an inferred price list. */
export const STATIC_CATALOG_SHAPES = [
  ...[50, 100, 150, 200, 250, 300].map((gib) => ({
    name: `${gib}G 1Month`,
    packageBytes: (BigInt(gib) * GIB).toString(),
    durationDays: 30,
  })),
  ...[50, 100, 150, 200, 250, 300, 350, 400, 500].map((gib) => ({
    name: `${gib}G 2Month`,
    packageBytes: (BigInt(gib) * GIB).toString(),
    durationDays: 60,
  })),
  ...[100, 150, 200, 250, 300, 350, 400, 450, 500].map((gib) => ({
    name: `${gib}G 3Month`,
    packageBytes: (BigInt(gib) * GIB).toString(),
    durationDays: 90,
  })),
  { name: 'Test 500MB', packageBytes: (GIB / 2n).toString(), durationDays: 2 },
] as const;

export function staticCatalogWithVerifiedPrices(
  prices: readonly StaticCatalogPrice[],
): StaticCatalogEntry[] {
  if (prices.length !== 25) throw new RangeError('STATIC_CATALOG_PRICE_COUNT');
  const byName = new Map(prices.map((row) => [row.name, row.amountToman]));
  if (byName.size !== 25)
    throw new RangeError('STATIC_CATALOG_PRICE_DUPLICATE');
  return STATIC_CATALOG_SHAPES.map((shape) => {
    const raw = byName.get(shape.name);
    if (!raw || !/^[1-9][0-9]{0,18}$/.test(raw))
      throw new RangeError('STATIC_CATALOG_PRICE_MISSING_OR_INVALID');
    if (BigInt(raw) > MAX_BIGINT)
      throw new RangeError('STATIC_CATALOG_PRICE_OVERFLOW');
    return { ...shape, amountToman: raw };
  });
}
