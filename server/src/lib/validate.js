// Request validation helpers built on zod. Validation failures become a 422 response with
// a per-field message map so every form can highlight exactly what is wrong.
import { z } from 'zod';
import { AppError } from './errors.js';
import { todayStr } from './dates.js';

export { z };

const emptyToNull = (schema) =>
  z.preprocess((v) => (v === '' || v === undefined || (typeof v === 'string' && v.trim() === '') ? null : v), schema);

export const v = {
  id: () => z.coerce.number({ invalid_type_error: 'Select a valid record.' }).int().positive('Select a valid record.'),
  text: (max = 200, label = 'This field') =>
    z
      .string({ required_error: `${label} is required.`, invalid_type_error: `${label} is required.` })
      .trim()
      .min(1, `${label} is required.`)
      .max(max, `${label} must be at most ${max} characters.`),
  optionalText: (max = 500) => emptyToNull(z.string().trim().max(max, `Must be at most ${max} characters.`).nullable()),
  date: (label = 'Date') =>
    z
      .string({ required_error: `${label} is required.` })
      .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} must be a valid date.`)
      .refine((s) => !Number.isNaN(Date.parse(s)), `${label} must be a valid date.`),
  optionalDate: () => emptyToNull(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date.').nullable()),
  time: () => z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:00)?$/, 'Enter a valid time (HH:MM).').transform((t) => t.slice(0, 5)),
  phone: (label = 'Phone') =>
    z.string({ required_error: `${label} is required.` }).trim().regex(/^\+?[0-9\s-]{7,20}$/, `${label} must be a valid phone number.`),
  optionalPhone: () => emptyToNull(z.string().trim().regex(/^\+?[0-9\s-]{7,20}$/, 'Enter a valid phone number.').nullable()),
  email: () => z.string().trim().toLowerCase().email('Enter a valid email address.').max(150),
  optionalEmail: () => emptyToNull(z.string().trim().toLowerCase().email('Enter a valid email address.').max(150).nullable()),
  money: (label = 'Amount') =>
    z.coerce
      .number({ invalid_type_error: `${label} must be a number.` })
      .finite()
      .nonnegative(`${label} cannot be negative.`)
      .max(100_000_000, `${label} is too large.`)
      .refine((n) => Math.round(n * 100) === n * 100 || Math.abs(Math.round(n * 100) - n * 100) < 1e-6, `${label} can have at most 2 decimals.`),
  pastDate: (label = 'Date') => v.date(label).refine((d) => d <= todayStr(), `${label} cannot be in the future.`),
  password: () =>
    z
      .string()
      .min(8, 'Password must be at least 8 characters.')
      .max(128, 'Password is too long.')
      .regex(/[A-Z]/, 'Password must contain an uppercase letter.')
      .regex(/[a-z]/, 'Password must contain a lowercase letter.')
      .regex(/[0-9]/, 'Password must contain a number.'),
  bool: () => z.preprocess((x) => (x === 'true' ? true : x === 'false' ? false : x), z.boolean()),
};

export function formatZodError(error) {
  const fields = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
}

export function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError(422, 'Please correct the highlighted fields.', { code: 'VALIDATION', fields: formatZodError(result.error) });
  }
  return result.data;
}

/** Express middleware: validate req.body / req.query / req.params and replace with parsed values. */
export const validate = (schemas) => (req, _res, next) => {
  if (schemas.body) req.body = parse(schemas.body, req.body ?? {});
  if (schemas.query) req.validQuery = parse(schemas.query, req.query ?? {});
  if (schemas.params) req.validParams = parse(schemas.params, req.params ?? {});
  next();
};

export const idParam = z.object({ id: v.id() });
