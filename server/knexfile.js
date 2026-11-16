import { env, isTest } from './src/config/env.js';

export default {
  client: 'pg',
  connection: isTest ? env.TEST_DATABASE_URL : env.DATABASE_URL,
  pool: {
    min: 0,
    max: env.DB_POOL_MAX,
    // Interpret date/time literals and day boundaries in the hospital's timezone.
    afterCreate: (conn, done) => conn.query(`SET TIME ZONE '${env.HOSPITAL_TZ.replace(/'/g, '')}'`, (err) => done(err, conn)),
  },
  migrations: { directory: './src/db/migrations', loadExtensions: ['.js'] },
};
