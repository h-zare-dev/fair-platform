import type { MigrationInterface, QueryRunner } from 'typeorm';

export class GibReview1792700000000 implements MigrationInterface {
  async up(r: QueryRunner): Promise<void> {
    await r.query(`ALTER TABLE fair_shadow_reviews
      ADD COLUMN rate_assignment_id bigint REFERENCES fair_tariff_assignments(id),
      ADD COLUMN rate_toman_per_gib bigint,
      DROP CONSTRAINT fair_shadow_reviews_check,
      ADD CONSTRAINT fair_shadow_reviews_kind CHECK (
        (rate_assignment_id IS NULL AND rate_toman_per_gib IS NULL AND (
          (package_id IS NULL AND amount_toman=0 AND package_bytes=0) OR
          (package_id IS NOT NULL AND amount_toman>0 AND package_bytes>0)))
        OR (rate_assignment_id IS NOT NULL AND rate_toman_per_gib IS NOT NULL
          AND rate_toman_per_gib>0 AND package_id IS NULL AND package_bytes>0
          AND amount_toman=ceil(package_bytes::numeric*rate_toman_per_gib/1073741824)))`);
  }
  async down(): Promise<void> {
    throw new Error('Cannot discard reviewed per-GiB decisions');
  }
}
