import { z } from 'zod';
import { ApiError } from './errors.js';

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    const first = r.error.issues[0];
    const where = first?.path.length ? `${first.path.join('.')}: ` : '';
    throw new ApiError(400, 'invalid_input', `${where}${first?.message ?? 'Invalid input'}`, r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

export const IdParam = z.object({ id: z.coerce.number().int().positive() });
