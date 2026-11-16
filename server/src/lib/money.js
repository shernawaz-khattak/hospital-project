// Monetary values are handled as integer paisa/cents internally to avoid float drift.
export const toCents = (n) => Math.round(Number(n) * 100);
export const fromCents = (c) => Math.round(c) / 100;
export const round2 = (n) => fromCents(toCents(n));
export const sumMoney = (values) => fromCents(values.reduce((acc, v) => acc + toCents(v), 0));
