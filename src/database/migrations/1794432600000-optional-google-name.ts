import type { MigrationInterface, QueryRunner } from 'typeorm';

export class OptionalGoogleName1794432600000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE users ALTER COLUMN given_name DROP NOT NULL',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Refuse to invent profile data when reverting users without a Google name.
    await queryRunner.query(
      'ALTER TABLE users ALTER COLUMN given_name SET NOT NULL',
    );
  }
}
