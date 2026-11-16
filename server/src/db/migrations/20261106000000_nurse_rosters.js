export async function up(knex) {
  await knex.schema.createTable('nurse_rosters', (table) => {
    table.increments('id').primary();
    table.integer('staff_id').notNullable().references('id').inTable('staff').onDelete('CASCADE');
    table.date('roster_date').notNullable();
    table.string('shift', 10).notNullable();
    table.timestamps(true, true);
    table.unique(['staff_id', 'roster_date']);
    table.check(`shift IN ('morning', 'evening', 'night', 'off')`);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('nurse_rosters');
}
