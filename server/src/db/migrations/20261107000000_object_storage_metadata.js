export async function up(knex) {
  await knex.schema.alterTable('lab_reports', (table) => {
    table.string('storage_provider', 20);
    table.text('storage_key');
    table.string('storage_bucket', 255);
    table.string('storage_status', 20);
  });

  await knex.schema.alterTable('backups', (table) => {
    table.string('storage_provider', 20);
    table.text('storage_key');
    table.string('storage_bucket', 255);
    table.string('storage_status', 20);
    table.timestamp('storage_verified_at');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('backups', (table) => {
    table.dropColumns('storage_provider', 'storage_key', 'storage_bucket', 'storage_status', 'storage_verified_at');
  });
  await knex.schema.alterTable('lab_reports', (table) => {
    table.dropColumns('storage_provider', 'storage_key', 'storage_bucket', 'storage_status');
  });
}
