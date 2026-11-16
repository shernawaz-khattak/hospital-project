export async function up(knex) {
  await knex.schema.createTable('storage_reconciliations', (table) => {
    table.increments('id').primary();
    table.string('provider', 20).notNullable();
    table.string('bucket', 255).notNullable();
    table.text('object_key').notNullable();
    table.string('operation', 40).notNullable();
    table.text('failure_reason');
    table.string('status', 30).notNullable().defaultTo('pending');
    table.integer('attempt_count').notNullable().defaultTo(0);
    table.timestamp('last_attempt_at');
    table.timestamp('resolved_at');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['provider', 'bucket', 'object_key', 'operation']);
    table.check("provider IN ('local', 'r2')");
    table.check("status IN ('pending', 'retrying', 'retry_failed', 'resolved', 'safely_retained')");
    table.index(['status', 'created_at'], 'storage_reconciliations_status_created_idx');
    table.index(['provider', 'bucket', 'object_key'], 'storage_reconciliations_object_idx');
  });

  await knex.schema.alterTable('backups', (table) => {
    table.string('retention_state', 30);
    table.timestamp('retention_state_at');
    table.check("retention_state IS NULL OR retention_state IN ('ready', 'pending_deletion', 'deleted', 'deletion_failed', 'pending_metadata_reconciliation')", undefined, 'backups_retention_state_check');
    table.index(['retention_state', 'started_at'], 'backups_retention_state_started_idx');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('backups', (table) => {
    table.dropColumns('retention_state', 'retention_state_at');
  });
  await knex.schema.dropTableIfExists('storage_reconciliations');
}
