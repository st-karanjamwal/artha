import { z } from 'zod';
import { parseToPaise } from './money';

export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const AADHAAR_RE = /^\d{12}$/;
export const MICR_RE = /^\d{9}$/;
export const SWIFT_RE = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

/** Optional text: '' allowed, trimmed. */
export const optText = z.string().trim().max(2000).optional().default('');

export const optPattern = (re: RegExp, msg: string) =>
  z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => v === '' || re.test(v), msg)
    .optional()
    .default('');

export const optDate = z
  .string()
  .refine((v) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Invalid date')
  .optional()
  .default('');

export const moneyField = (opts: { required?: boolean; allowNegative?: boolean } = {}) =>
  z.string().superRefine((v, ctx) => {
    const p = parseToPaise(v);
    if (v.trim() === '') {
      if (opts.required) ctx.addIssue({ code: 'custom', message: 'Required' });
      return;
    }
    if (p == null) ctx.addIssue({ code: 'custom', message: 'Enter an amount like 12,345.67' });
    else if (!opts.allowNegative && p < 0)
      ctx.addIssue({ code: 'custom', message: 'Must be positive' });
  });

export const percentField = z
  .string()
  .trim()
  .refine((v) => v === '' || /^\d{1,3}(\.\d{1,4})?$/.test(v), 'Enter a number like 7.10')
  .optional()
  .default('');

export const last4 = (s: string) => s.replace(/\s/g, '').slice(-4);
export const blankToNull = (s: string | null | undefined) =>
  s && s.trim() !== '' ? s.trim() : null;
