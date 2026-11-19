import type { DataSource, EntityManager } from 'typeorm';
import { integer } from '@fair-platform/pricing';
import {
  jalaliValidityWindow,
  validateTimeZone,
} from '@fair-platform/calendar';

export class CatalogError extends Error {
  constructor(
    readonly code:
      | 'INVALID_CATALOG_INPUT'
      | 'CATALOG_NOT_FOUND'
      | 'PACKAGE_ALREADY_ASSIGNED',
  ) {
    super(code);
  }
}

const source = (v: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(v))
    throw new CatalogError('INVALID_CATALOG_INPUT');
  return v;
};
const name = (v: string) => {
  const trimmed = v.trim();
  if (!trimmed || trimmed.length > 100)
    throw new CatalogError('INVALID_CATALOG_INPUT');
  return trimmed;
};
const id = (v: string) => String(integer(v));
const adminId = (v: string) => String(integer(v, true));
const amount = (v: string) => String(integer(v));
const days = (v: number) => {
  if (!Number.isInteger(v) || v <= 0 || v > 36500)
    throw new CatalogError('INVALID_CATALOG_INPUT');
  return v;
};

export interface CatalogPackageInput {
  sourceInstanceId: string;
  name: string;
  packageBytes: string;
  durationDays: number;
  amountToman: string;
}
export interface CatalogAssignmentInput {
  sourceInstanceId: string;
  targetKind: 'GROUP' | 'ADMIN';
  targetId: string;
  packageId?: string | undefined;
  rateTomanPerGiB?: string | undefined;
  startDate: string | null;
  endDate: string | null;
}

export class PostgresCatalogStore {
  readonly zone: string;
  constructor(
    private readonly db: DataSource,
    zone: string = 'Asia/Tehran',
  ) {
    this.zone = validateTimeZone(zone);
  }

  async list(sourceInstanceId: string) {
    const s = source(sourceInstanceId);
    const [groups, memberships, membershipHistory, packages, assignments] =
      await Promise.all([
        this.db.query<{ id: string; name: string }[]>(
          'SELECT id::text,name FROM fair_admin_groups WHERE source_instance_id=$1 ORDER BY name LIMIT 500',
          [s],
        ),
        this.db.query<{ billingAdminId: string; groupId: string }[]>(
          'SELECT billing_admin_id::text AS "billingAdminId", group_id::text AS "groupId" FROM fair_admin_group_memberships WHERE source_instance_id=$1 ORDER BY billing_admin_id LIMIT 2000',
          [s],
        ),
        this.db.query<
          {
            id: string;
            billingAdminId: string;
            oldGroupId: string | null;
            newGroupId: string | null;
            action: string;
            changedAt: Date;
          }[]
        >(
          `SELECT id::text,billing_admin_id::text AS "billingAdminId",old_group_id::text AS "oldGroupId",
                new_group_id::text AS "newGroupId",action, changed_at AS "changedAt"
         FROM fair_admin_group_membership_audit WHERE source_instance_id=$1 ORDER BY id DESC LIMIT 200`,
          [s],
        ),
        this.db.query<
          {
            id: string;
            name: string;
            packageBytes: string;
            durationDays: number;
            amountToman: string;
            everAssigned: boolean;
          }[]
        >(
          `SELECT id::text,name,package_bytes::text AS "packageBytes",duration_days AS "durationDays",
                amount_toman::text AS "amountToman",ever_assigned AS "everAssigned"
         FROM fair_atomic_packages WHERE source_instance_id=$1 ORDER BY id DESC LIMIT 500`,
          [s],
        ),
        this.db.query<
          {
            id: string;
            targetKind: 'GROUP' | 'ADMIN';
            groupId: string | null;
            billingAdminId: string | null;
            packageId: string | null;
            rateTomanPerGiB: string | null;
            packageBytes: string | null;
            durationDays: number | null;
            startDate: string;
            endDate: string | null;
            timeZone: string;
          }[]
        >(
          `SELECT id::text,target_kind AS "targetKind",group_id::text AS "groupId",
                billing_admin_id::text AS "billingAdminId",package_id::text AS "packageId",
                rate_toman_per_gib::text AS "rateTomanPerGiB",package_bytes::text AS "packageBytes",
                duration_days AS "durationDays",local_start_date AS "startDate",local_end_date AS "endDate",
                time_zone AS "timeZone"
         FROM fair_tariff_assignments WHERE source_instance_id=$1 ORDER BY id DESC LIMIT 500`,
          [s],
        ),
      ]);
    return {
      sourceInstanceId: s,
      timeZone: this.zone,
      groups,
      memberships,
      membershipHistory,
      packages,
      assignments,
    };
  }

  async createGroup(input: { sourceInstanceId: string; name: string }) {
    const [row] = await this.db.query<{ id: string }[]>(
      'INSERT INTO fair_admin_groups(source_instance_id,name) VALUES($1,$2) RETURNING id::text',
      [source(input.sourceInstanceId), name(input.name)],
    );
    return { id: row!.id };
  }

  async changeMembership(input: {
    sourceInstanceId: string;
    billingAdminId: string;
    groupId: string | null;
  }) {
    const s = source(input.sourceInstanceId);
    const admin = adminId(input.billingAdminId);
    const group = input.groupId === null ? null : id(input.groupId);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `membership:${s}:${admin}`,
      ]);
      const [current] = await tx.query<{ groupId: string }[]>(
        'SELECT group_id::text AS "groupId" FROM fair_admin_group_memberships WHERE source_instance_id=$1 AND billing_admin_id=$2',
        [s, admin],
      );
      const old = current?.groupId ?? null;
      if (old === group) throw new CatalogError('INVALID_CATALOG_INPUT');
      if (group !== null) {
        const target = await tx.query<{ id: string }[]>(
          'SELECT id FROM fair_admin_groups WHERE id=$1 AND source_instance_id=$2',
          [group, s],
        );
        if (!target.length) throw new CatalogError('CATALOG_NOT_FOUND');
        await tx.query(
          `INSERT INTO fair_admin_group_memberships(source_instance_id,billing_admin_id,group_id)
           VALUES($1,$2,$3) ON CONFLICT(source_instance_id,billing_admin_id)
           DO UPDATE SET group_id=EXCLUDED.group_id,updated_at=clock_timestamp()`,
          [s, admin, group],
        );
      } else {
        if (old === null) throw new CatalogError('CATALOG_NOT_FOUND');
        await tx.query(
          'DELETE FROM fair_admin_group_memberships WHERE source_instance_id=$1 AND billing_admin_id=$2',
          [s, admin],
        );
      }
      const action =
        old === null ? 'ASSIGN' : group === null ? 'REMOVE' : 'TRANSFER';
      await tx.query(
        `INSERT INTO fair_admin_group_membership_audit(source_instance_id,billing_admin_id,old_group_id,new_group_id,action)
         VALUES($1,$2,$3,$4,$5)`,
        [s, admin, old, group, action],
      );
      return { billingAdminId: admin, oldGroupId: old, groupId: group, action };
    });
  }

  async createPackage(input: CatalogPackageInput) {
    const [row] = await this.db.query<{ id: string }[]>(
      `INSERT INTO fair_atomic_packages(source_instance_id,name,package_bytes,duration_days,amount_toman)
       VALUES($1,$2,$3,$4,$5) RETURNING id::text`,
      [
        source(input.sourceInstanceId),
        name(input.name),
        amount(input.packageBytes),
        days(input.durationDays),
        amount(input.amountToman),
      ],
    );
    return { id: row!.id };
  }

  async editPackage(input: CatalogPackageInput & { packageId: string }) {
    const [row] = await this.db.query<{ id: string }[]>(
      `UPDATE fair_atomic_packages SET name=$3,package_bytes=$4,duration_days=$5,amount_toman=$6
       WHERE id=$1 AND source_instance_id=$2 AND NOT ever_assigned RETURNING id::text`,
      [
        id(input.packageId),
        source(input.sourceInstanceId),
        name(input.name),
        amount(input.packageBytes),
        days(input.durationDays),
        amount(input.amountToman),
      ],
    );
    if (!row) throw new CatalogError('PACKAGE_ALREADY_ASSIGNED');
    return { id: row.id };
  }

  async copyPackage(input: {
    sourceInstanceId: string;
    packageId: string;
    name: string;
    amountToman: string;
  }) {
    const [row] = await this.db.query<{ id: string }[]>(
      `INSERT INTO fair_atomic_packages(source_instance_id,name,package_bytes,duration_days,amount_toman)
       SELECT source_instance_id,$3,package_bytes,duration_days,$4 FROM fair_atomic_packages
       WHERE id=$1 AND source_instance_id=$2 RETURNING id::text`,
      [
        id(input.packageId),
        source(input.sourceInstanceId),
        name(input.name),
        amount(input.amountToman),
      ],
    );
    if (!row) throw new CatalogError('CATALOG_NOT_FOUND');
    return { id: row.id };
  }

  async assign(input: CatalogAssignmentInput) {
    const s = source(input.sourceInstanceId);
    const target =
      input.targetKind === 'ADMIN'
        ? adminId(input.targetId)
        : id(input.targetId);
    if (
      (input.packageId === undefined) ===
      (input.rateTomanPerGiB === undefined)
    )
      throw new CatalogError('INVALID_CATALOG_INPUT');
    const range = jalaliValidityWindow(
      this.zone,
      input.startDate,
      input.endDate,
    );
    return this.db.transaction(async (tx: EntityManager) => {
      let pkg: { packageBytes: string; durationDays: number } | undefined;
      if (input.packageId !== undefined) {
        const [found] = await tx.query<
          { packageBytes: string; durationDays: number }[]
        >(
          `SELECT package_bytes::text AS "packageBytes", duration_days AS "durationDays"
           FROM fair_atomic_packages WHERE id=$1 AND source_instance_id=$2 FOR UPDATE`,
          [id(input.packageId), s],
        );
        if (!found) throw new CatalogError('CATALOG_NOT_FOUND');
        pkg = found;
      }
      const [row] = await tx.query<{ id: string }[]>(
        `INSERT INTO fair_tariff_assignments(source_instance_id,target_kind,group_id,billing_admin_id,
         package_id,rate_toman_per_gib,package_bytes,duration_days,local_start_date,local_end_date,
         time_zone,effective_from,effective_until)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id::text`,
        [
          s,
          input.targetKind,
          input.targetKind === 'GROUP' ? target : null,
          input.targetKind === 'ADMIN' ? target : null,
          input.packageId === undefined ? null : id(input.packageId),
          input.rateTomanPerGiB === undefined
            ? null
            : amount(input.rateTomanPerGiB),
          pkg?.packageBytes ?? null,
          pkg?.durationDays ?? null,
          range.startDate,
          range.endDate,
          range.zone,
          range.fromUtc,
          range.untilUtc,
        ],
      );
      if (pkg)
        await tx.query(
          'UPDATE fair_atomic_packages SET ever_assigned=true WHERE id=$1',
          [id(input.packageId!)],
        );
      return { id: row!.id, ...range };
    });
  }

  async changeEnd(input: {
    sourceInstanceId: string;
    assignmentId: string;
    endDate: string | null;
  }) {
    const s = source(input.sourceInstanceId);
    return this.db.transaction(async (tx) => {
      const [old] = await tx.query<{ startDate: string; timeZone: string }[]>(
        `SELECT local_start_date AS "startDate",time_zone AS "timeZone"
         FROM fair_tariff_assignments WHERE id=$1 AND source_instance_id=$2 FOR UPDATE`,
        [id(input.assignmentId), s],
      );
      if (!old) throw new CatalogError('CATALOG_NOT_FOUND');
      const range = jalaliValidityWindow(
        old.timeZone,
        old.startDate,
        input.endDate,
      );
      await tx.query(
        `UPDATE fair_tariff_assignments SET local_end_date=$3,effective_until=$4 WHERE id=$1 AND source_instance_id=$2`,
        [id(input.assignmentId), s, range.endDate, range.untilUtc],
      );
      return { id: input.assignmentId, ...range };
    });
  }
}
