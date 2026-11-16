import knexFactory from 'knex';
import pg from 'pg';
import config from '../../knexfile.js';

// Return DATE columns as 'YYYY-MM-DD' strings and NUMERIC as JS numbers.
// Dates are calendar values in the hospital's timezone; converting them to JS Date
// objects would shift them across midnight for some clients.
pg.types.setTypeParser(1082, (v) => v); // date
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // bigint (counts)

export const db = knexFactory(config);

export async function closeDb() {
  await db.destroy();
}
