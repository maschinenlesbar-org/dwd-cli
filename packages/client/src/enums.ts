// Enum-like value sets. These const arrays double as runtime CLI choice
// validators and as TS union types.

/** Languages the warning feeds are published in. */
export const LangValues = ["de", "en"] as const;
export type Lang = (typeof LangValues)[number];
