import { z } from 'zod';

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** Runs a knex query with pagination and returns { data, page, pageSize, total }. */
export async function paginate(query, { page = 1, pageSize = 20 }) {
  const countQuery = query.clone().clearSelect().clearOrder().count({ total: '*' }).first();
  const [{ total } = { total: 0 }, data] = await Promise.all([
    countQuery,
    query.offset((page - 1) * pageSize).limit(pageSize),
  ]);
  return { data, page, pageSize, total: Number(total) };
}
