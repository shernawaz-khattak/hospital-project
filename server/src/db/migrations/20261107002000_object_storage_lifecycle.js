export async function up(knex) {
  await knex.schema.createTable('object_storage_lifecycle', (table) => {
    table.increments('id').primary();
    table.string('provider', 20).notNullable();
    table.string('bucket', 255).notNullable();
    table.text('object_key').notNullable();
    table.string('state', 30).notNullable().defaultTo('active');
    table.string('lease_token', 64);
    table.timestamp('lease_expires_at', { useTz: true });
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['provider', 'bucket', 'object_key']);
    table.check("provider IN ('local', 'r2')", undefined, 'object_storage_lifecycle_provider_check');
    table.check("state IN ('active', 'pending_deletion', 'deleted', 'deletion_failed')", undefined, 'object_storage_lifecycle_state_check');
    table.check("(state = 'active' OR state = 'deleted') OR lease_token IS NOT NULL", undefined, 'object_storage_lifecycle_lease_check');
    table.index(['state', 'updated_at'], 'object_storage_lifecycle_state_updated_idx');
  });

  await knex.raw(`
    INSERT INTO object_storage_lifecycle (provider, bucket, object_key, state)
    SELECT storage_provider, COALESCE(storage_bucket, ''), storage_key, 'active'
    FROM lab_reports
    WHERE storage_key IS NOT NULL AND storage_provider IS NOT NULL AND storage_status IS DISTINCT FROM 'deleted'
    UNION
    SELECT storage_provider, COALESCE(storage_bucket, ''), storage_key, 'active'
    FROM backups
    WHERE storage_key IS NOT NULL AND storage_provider IS NOT NULL AND storage_status IS DISTINCT FROM 'deleted'
    ON CONFLICT (provider, bucket, object_key) DO NOTHING
  `);

  await knex.schema.alterTable('lab_reports', (table) => {
    table.check("storage_provider IS NULL OR storage_provider IN ('local', 'r2')", undefined, 'lab_reports_storage_provider_check');
    table.check("storage_status IS NULL OR storage_status IN ('pending', 'ready', 'deleted', 'failed')", undefined, 'lab_reports_storage_status_check');
    table.check("(storage_key IS NULL AND storage_provider IS NULL AND storage_bucket IS NULL) OR (storage_key IS NOT NULL AND storage_provider IN ('local', 'r2'))", undefined, 'lab_reports_storage_metadata_check');
    table.index(['storage_provider', 'storage_bucket', 'storage_key'], 'lab_reports_storage_object_lookup_idx');
  });

  await knex.schema.alterTable('backups', (table) => {
    table.check("storage_provider IS NULL OR storage_provider IN ('local', 'r2')", undefined, 'backups_storage_provider_check');
    table.check("storage_status IS NULL OR storage_status IN ('pending', 'ready', 'deleted', 'failed')", undefined, 'backups_storage_status_check');
    table.check("(storage_key IS NULL AND storage_provider IS NULL AND storage_bucket IS NULL) OR (storage_key IS NOT NULL AND storage_provider IN ('local', 'r2'))", undefined, 'backups_storage_metadata_check');
    table.check("(storage_key IS NULL) OR (storage_status IS NULL OR storage_status IN ('ready', 'deleted')) OR storage_status = 'failed'", undefined, 'backups_storage_status_metadata_check');
    table.index(['storage_provider', 'storage_bucket', 'storage_key'], 'backups_storage_object_lookup_idx');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('backups', (table) => {
    table.dropIndex([], 'backups_storage_object_lookup_idx');
    table.dropChecks(['backups_storage_status_metadata_check', 'backups_storage_metadata_check', 'backups_storage_status_check', 'backups_storage_provider_check']);
  });
  await knex.schema.alterTable('lab_reports', (table) => {
    table.dropIndex([], 'lab_reports_storage_object_lookup_idx');
    table.dropChecks(['lab_reports_storage_metadata_check', 'lab_reports_storage_status_check', 'lab_reports_storage_provider_check']);
  });
  await knex.schema.dropTableIfExists('object_storage_lifecycle');
}
