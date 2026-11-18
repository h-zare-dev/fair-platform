import type { DataSource, EntityManager } from 'typeorm';
import {
  integer,
  utc,
  price,
  PricingError,
  type PricingMode,
  type PricingRequest,
  type PricingQuote,
  type PricingRule,
} from '@fair-platform/pricing';

export interface PricingPlanInput {
  sourceInstanceId: string;
  name: string;
}
export interface PricingVersionInput {
  sourceInstanceId: string;
  planId?: string | undefined;
  billingAdminId?: string | undefined;
  mode: PricingMode;
  rateTomanPerGiB: string | null;
  fixedPackages: Record<string, string>;
  effectiveFrom: string;
  effectiveUntil: string | null;
}
export interface PricingAssignmentInput {
  sourceInstanceId: string;
  planId: string;
  billingAdminId: string | null;
  effectiveFrom: string;
  effectiveUntil: string | null;
}
export interface PricingReader {
  list(source: string): Promise<unknown>;
  createPlan(input: PricingPlanInput): Promise<{ id: string }>;
  createVersion(input: PricingVersionInput): Promise<{ id: string }>;
  assign(input: PricingAssignmentInput): Promise<{ id: string }>;
  quote(input: PricingRequest): Promise<PricingQuote>;
}

const validSource = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(v))
    throw new PricingError('INVALID_PRICING_INPUT');
  return v;
};
const validWindow = (from: string, until: string | null) => {
  const a = utc(from);
  const b = until === null ? null : utc(until);
  if (b !== null && b <= a) throw new PricingError('INVALID_PRICING_INPUT');
  return { a, b };
};
const id = (v: unknown): string => String(integer(v));
const admin = (v: unknown): string => String(integer(v, true));
const timestamp = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Source-scoped append-only configuration; exclusion constraints serialize competing writes. */
export class PostgresPricingStore implements PricingReader {
  constructor(private readonly db: DataSource) {}

  async list(source: string) {
    const s = validSource(source);
    const [plans, versions, assignments] = await Promise.all([
      this.db.query<{ id: string; name: string }[]>(
        'SELECT id::text, name FROM fair_pricing_plans WHERE source_instance_id=$1 ORDER BY id DESC LIMIT 200',
        [s],
      ),
      this.db.query<
        {
          id: string;
          planId: string | null;
          billingAdminId: string | null;
          mode: PricingMode;
          rateTomanPerGiB: string | null;
          effectiveFrom: string;
          effectiveUntil: string | null;
          fixedPackages: Record<string, string>;
        }[]
      >(
        `SELECT v.id::text, v.plan_id::text AS "planId", v.billing_admin_id::text AS "billingAdminId", v.mode,
        v.rate_toman_per_gib::text AS "rateTomanPerGiB", ${timestamp('v.effective_from')} AS "effectiveFrom",
        CASE WHEN v.effective_until IS NULL THEN NULL ELSE ${timestamp('v.effective_until')} END AS "effectiveUntil",
        COALESCE((SELECT jsonb_object_agg(f.package_bytes::text, f.amount_toman::text)
          FROM fair_pricing_fixed_packages f WHERE f.rule_version_id=v.id), '{}'::jsonb) AS "fixedPackages"
        FROM fair_pricing_rule_versions v WHERE v.source_instance_id=$1 ORDER BY v.id DESC LIMIT 200`,
        [s],
      ),
      this.db.query<
        {
          id: string;
          planId: string;
          billingAdminId: string | null;
          effectiveFrom: string;
          effectiveUntil: string | null;
        }[]
      >(
        `SELECT id::text, plan_id::text AS "planId", billing_admin_id::text AS "billingAdminId",
        ${timestamp('effective_from')} AS "effectiveFrom",
        CASE WHEN effective_until IS NULL THEN NULL ELSE ${timestamp('effective_until')} END AS "effectiveUntil"
        FROM fair_pricing_assignments WHERE source_instance_id=$1 ORDER BY id DESC LIMIT 200`,
        [s],
      ),
    ]);
    return { sourceInstanceId: s, plans, versions, assignments };
  }

  private async audit(
    m: EntityManager,
    action: string,
    objectId: string,
    source: string,
  ) {
    await m.query(
      'INSERT INTO fair_pricing_audit (action,object_id,source_instance_id) VALUES ($1,$2,$3)',
      [action, objectId, source],
    );
  }

  async createPlan(input: PricingPlanInput) {
    const source = validSource(input.sourceInstanceId);
    const name = input.name.trim();
    if (!name || name.length > 100)
      throw new PricingError('INVALID_PRICING_INPUT');
    return this.db.transaction(async (m) => {
      const [row] = await m.query<{ id: string }[]>(
        'INSERT INTO fair_pricing_plans (source_instance_id,name) VALUES ($1,$2) RETURNING id::text',
        [source, name],
      );
      if (!row) throw new Error('PRICING_INSERT_FAILED');
      await this.audit(m, 'CREATE_PLAN', row.id, source);
      return { id: row.id };
    });
  }

  async createVersion(input: PricingVersionInput) {
    const source = validSource(input.sourceInstanceId);
    const { a, b } = validWindow(input.effectiveFrom, input.effectiveUntil);
    if ((input.planId === undefined) === (input.billingAdminId === undefined))
      throw new PricingError('INVALID_PRICING_INPUT');
    const planId = input.planId === undefined ? null : id(input.planId);
    const billingAdminId =
      input.billingAdminId === undefined ? null : admin(input.billingAdminId);
    if (!['PER_GIB', 'FIXED', 'MIXED'].includes(input.mode))
      throw new PricingError('INVALID_PRICING_INPUT');
    if (
      (input.mode === 'PER_GIB' && input.rateTomanPerGiB === null) ||
      (input.mode === 'FIXED' && input.rateTomanPerGiB !== null)
    )
      throw new PricingError('INVALID_PRICING_INPUT');
    const rate =
      input.rateTomanPerGiB === null ? null : id(input.rateTomanPerGiB);
    const catalog = Object.entries(input.fixedPackages);
    if (catalog.length > 100 || (input.mode === 'PER_GIB' && catalog.length))
      throw new PricingError('INVALID_PRICING_INPUT');
    for (const [bytes, cost] of catalog) {
      id(bytes);
      id(cost);
    }
    return this.db.transaction(async (m) => {
      const [row] = await m.query<{ id: string }[]>(
        `INSERT INTO fair_pricing_rule_versions
        (source_instance_id, plan_id, billing_admin_id, mode, rate_toman_per_gib, effective_from, effective_until)
        VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz) RETURNING id::text`,
        [source, planId, billingAdminId, input.mode, rate, a, b],
      );
      if (!row) throw new Error('PRICING_INSERT_FAILED');
      for (const [bytes, amount] of catalog)
        await m.query(
          'INSERT INTO fair_pricing_fixed_packages (rule_version_id,package_bytes,amount_toman) VALUES ($1,$2,$3)',
          [row.id, bytes, amount],
        );
      await this.audit(m, 'CREATE_RULE', row.id, source);
      return { id: row.id };
    });
  }

  async assign(input: PricingAssignmentInput) {
    const source = validSource(input.sourceInstanceId);
    const { a, b } = validWindow(input.effectiveFrom, input.effectiveUntil);
    const plan = id(input.planId);
    const billingAdminId =
      input.billingAdminId === null ? null : admin(input.billingAdminId);
    return this.db.transaction(async (m) => {
      const [row] = await m.query<{ id: string }[]>(
        `INSERT INTO fair_pricing_assignments
        (source_instance_id,plan_id,billing_admin_id,effective_from,effective_until)
        VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz) RETURNING id::text`,
        [source, plan, billingAdminId, a, b],
      );
      if (!row) throw new Error('PRICING_INSERT_FAILED');
      await this.audit(m, 'ASSIGN_PLAN', row.id, source);
      return { id: row.id };
    });
  }

  /** A configured high priority tier with no matching rule never falls through. */
  async quote(input: PricingRequest) {
    const source = validSource(input.sourceInstanceId);
    const billingAdminId = admin(input.billingAdminId);
    const when = utc(input.occurredAt);
    const byteCount = id(input.billableBytes);
    if (input.unlimited === true)
      throw new PricingError('UNEXPECTED_UNLIMITED');
    if (input.purpose !== 'FULL_PACKAGE' && input.purpose !== 'POSITIVE_DELTA')
      throw new PricingError('INVALID_PRICING_INPUT');
    return this.db.transaction('REPEATABLE READ', async (m) => {
      const overrides: { id: string }[] = await m.query(
        `SELECT id::text FROM fair_pricing_rule_versions
        WHERE source_instance_id=$1 AND billing_admin_id=$2 AND effective_from<=$3::timestamptz
          AND (effective_until IS NULL OR effective_until>$3::timestamptz) LIMIT 2`,
        [source, billingAdminId, when],
      );
      let version: string | null = overrides[0]?.id ?? null;
      let tier: PricingRule['source'] = 'ADMIN_OVERRIDE';
      if (overrides.length > 1)
        throw new PricingError('PRICING_CONFIG_CONFLICT');
      if (!version) {
        for (const adminValue of [billingAdminId, null]) {
          const assignment: { id: string; plan_id: string }[] = await m.query(
            `SELECT id::text,plan_id::text FROM fair_pricing_assignments
            WHERE source_instance_id=$1 AND billing_admin_id IS NOT DISTINCT FROM $2::bigint
              AND effective_from<=$3::timestamptz
              AND (effective_until IS NULL OR effective_until>$3::timestamptz) LIMIT 2`,
            [source, adminValue, when],
          );
          if (assignment.length > 1)
            throw new PricingError('PRICING_CONFIG_CONFLICT');
          if (!assignment.length) continue;
          tier = adminValue === null ? 'DEFAULT_PLAN' : 'ASSIGNED_PLAN';
          const matched: { id: string }[] = await m.query(
            `SELECT id::text FROM fair_pricing_rule_versions
            WHERE plan_id=$1 AND effective_from<=$2::timestamptz
              AND (effective_until IS NULL OR effective_until>$2::timestamptz) LIMIT 2`,
            [assignment[0]!.plan_id, when],
          );
          if (matched.length > 1)
            throw new PricingError('PRICING_CONFIG_CONFLICT');
          if (!matched.length) throw new PricingError('PRICING_MISSING');
          version = matched[0]!.id;
          break;
        }
      }
      if (!version) throw new PricingError('PRICING_MISSING');
      const rows: {
        id: string;
        mode: PricingMode;
        rate: string | null;
        from: string;
        until: string | null;
        fixed: Record<string, string>;
      }[] = await m.query(
        `SELECT v.id::text AS id, v.mode, v.rate_toman_per_gib::text AS rate,
          ${timestamp('v.effective_from')} AS "from",
          CASE WHEN v.effective_until IS NULL THEN NULL ELSE ${timestamp('v.effective_until')} END AS "until",
          COALESCE((SELECT jsonb_object_agg(f.package_bytes::text,f.amount_toman::text)
            FROM fair_pricing_fixed_packages f WHERE f.rule_version_id=v.id), '{}'::jsonb) AS fixed
          FROM fair_pricing_rule_versions v WHERE v.id=$1 AND v.source_instance_id=$2`,
        [version, source],
      );
      const v = rows[0];
      if (!v) throw new PricingError('PRICING_MISSING');
      return price(
        {
          ...input,
          sourceInstanceId: source,
          billingAdminId,
          occurredAt: when,
          billableBytes: byteCount,
        },
        [
          {
            versionId: v.id,
            source: tier,
            sourceInstanceId: source,
            billingAdminId: tier === 'DEFAULT_PLAN' ? null : billingAdminId,
            mode: v.mode,
            rateTomanPerGiB: v.rate,
            fixedPackages: v.fixed,
            effectiveFrom: v.from,
            effectiveUntil: v.until,
          },
        ],
      );
    });
  }
}
