export async function up(knex) {
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS admissions_active_patient_uq
      ON admissions (patient_id)
      WHERE status = 'active';

    CREATE UNIQUE INDEX IF NOT EXISTS bill_items_admission_room_uq
      ON bill_items (source_type, source_id, period_start, period_end)
      WHERE source_type = 'admission' AND source_id IS NOT NULL
        AND period_start IS NOT NULL AND period_end IS NOT NULL;
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP INDEX IF EXISTS bill_items_admission_room_uq;
    DROP INDEX IF EXISTS admissions_active_patient_uq;
  `);
}
