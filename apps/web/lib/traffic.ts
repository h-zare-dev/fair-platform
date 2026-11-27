/** UI-only GiB conversion. The API and ledger continue to use exact integer bytes. */
const GIB = 1_073_741_824n;
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;

export function asciiDigits(input: string): string {
  return input
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/٬/g, '')
    .replace(/٫/g, '.')
    .trim();
}

export function gibToBytes(input: string): string {
  const normalized = asciiDigits(input);
  if (!/^\d+(?:\.\d+)?$/.test(normalized))
    throw new Error('حجم را به‌صورت عدد مثبت بر حسب گیگابایت وارد کنید.');
  const [whole = '0', decimal = ''] = normalized.split('.');
  if (decimal.length > 18) throw new Error('دقت اعشار حجم بیش از حد مجاز است.');
  const denominator = 10n ** BigInt(decimal.length);
  const numerator = BigInt(whole) * denominator + BigInt(decimal || '0');
  // Decimal GiB such as 0.2 cannot be expressed as an integral number of
  // bytes. Choose the nearest byte explicitly; all persisted values remain
  // integers and the conversion error is bounded by half a byte.
  const bytes = (numerator * GIB + denominator / 2n) / denominator;
  if (bytes <= 0n || bytes > MAX_SIGNED_BIGINT)
    throw new Error('حجم باید بیشتر از صفر و در محدودهٔ مجاز باشد.');
  return bytes.toString();
}

/** Editable decimal GiB, with enough precision to round-trip any byte count. */
export function bytesToEditableGiB(input: string): string {
  const bytes = BigInt(input);
  if (bytes <= 0n) throw new Error('حجم نامعتبر است.');
  const scale = 1_000_000_000_000n;
  const scaled = (bytes * scale + GIB / 2n) / GIB;
  const fraction = (scaled % scale)
    .toString()
    .padStart(12, '0')
    .replace(/0+$/, '');
  return `${scaled / scale}${fraction ? `.${fraction}` : ''}`;
}

export function fixedCatalogGiB(input: string): Record<string, string> {
  const catalog: Record<string, string> = {};
  if (!input.trim()) return catalog;
  const parts = input.split(/[,،\n]+/).map((part) => part.trim());
  if (parts.length > 100) throw new Error('حداکثر ۱۰۰ بستهٔ ثابت مجاز است.');
  for (const part of parts) {
    const pair = part.split(':');
    if (pair.length !== 2)
      throw new Error('فرمت بسته: گیگابایت:تومان؛ مانند ۵۰:۱۵۰۰۰۰');
    const bytes = gibToBytes(pair[0] ?? '');
    const amount = asciiDigits(pair[1] ?? '');
    if (!/^[1-9]\d*$/.test(amount) || BigInt(amount) > MAX_SIGNED_BIGINT)
      throw new Error('قیمت هر بسته باید عدد صحیح مثبت به تومان باشد.');
    if (Object.hasOwn(catalog, bytes))
      throw new Error('حجم گیگابایت تکراری در فهرست بسته‌ها وجود دارد.');
    catalog[bytes] = amount;
  }
  return catalog;
}

/** Convert separately entered GiB/price pairs, with no implicit partial rows. */
export function fixedRowsToCatalog(
  rows: ReadonlyArray<{ gib: string; toman: string }>,
  allowEmpty = false,
): Record<string, string> {
  if (rows.some((row) => Boolean(row.gib.trim()) !== Boolean(row.toman.trim())))
    throw new Error('حجم و قیمت هر بسته را با هم تکمیل کنید.');
  const completed = rows.filter((row) => row.gib.trim() && row.toman.trim());
  if (!allowEmpty && completed.length === 0)
    throw new Error('حداقل یک بسته با حجم و قیمت مشخص وارد کنید.');
  return fixedCatalogGiB(
    completed.map((row) => `${row.gib}:${row.toman}`).join(','),
  );
}

const persian = new Intl.NumberFormat('fa-IR');
export function formatInteger(value: string | number | bigint): string {
  try {
    return persian.format(BigInt(value));
  } catch {
    return '—';
  }
}

/** Up to 6 fractional GiB digits; mark approximations, never round stored bytes. */
export function formatGiB(value: string): string {
  try {
    const bytes = BigInt(value);
    if (bytes < 0n) return '—';
    const integer = bytes / GIB;
    const remainder = bytes % GIB;
    if (remainder === 0n) return `${formatInteger(integer)} گیگابایت`;
    const precision = 1_000_000n;
    const scaled = (remainder * precision) / GIB;
    if (integer === 0n && scaled === 0n) return 'کمتر از ۰٫۰۰۰۰۰۱ گیگابایت';
    const exact = (remainder * precision) % GIB === 0n;
    let fractional = scaled.toString().padStart(6, '0').replace(/0+$/, '');
    if (!fractional) fractional = '0';
    const localized = fractional.replace(/\d/g, (v) =>
      String.fromCharCode(v.charCodeAt(0) + 0x06c0),
    );
    return `${exact ? '' : 'حدود '}${formatInteger(integer)}٫${localized} گیگابایت`;
  } catch {
    return '—';
  }
}

export function formatUtc(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return `${new Intl.DateTimeFormat('fa-IR-u-ca-gregory', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(date)} (UTC)`;
}
