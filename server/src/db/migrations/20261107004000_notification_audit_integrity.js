export async function up(knex) {
  await knex.raw(`
    DELETE FROM notifications duplicate
    USING notifications original
    WHERE duplicate.id > original.id
      AND duplicate.user_id IS NOT DISTINCT FROM original.user_id
      AND duplicate.event_type = original.event_type
      AND duplicate.entity_type IS NOT DISTINCT FROM original.entity_type
      AND duplicate.entity_id IS NOT DISTINCT FROM original.entity_id
      AND duplicate.entity_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX notifications_user_event_entity_unique
    ON notifications (user_id, event_type, entity_type, entity_id)
    WHERE user_id IS NOT NULL AND entity_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX notifications_patient_event_entity_unique
    ON notifications (patient_id, event_type, entity_type, entity_id)
    WHERE patient_id IS NOT NULL AND entity_id IS NOT NULL
  `);
};

export async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS notifications_patient_event_entity_unique');
  await knex.raw('DROP INDEX IF EXISTS notifications_user_event_entity_unique');
};
