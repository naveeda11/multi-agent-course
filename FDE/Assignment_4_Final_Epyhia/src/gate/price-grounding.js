import { ValidationError } from "../shared/errors.js";

const SYMBOL_CURRENCIES = Object.freeze({
  "$": new Set(["usd", "cad", "aud", "nzd"]),
  "€": new Set(["eur"]),
  "£": new Set(["gbp"]),
});

export function assertGroundedCurrencyClaims(text, catalog, label) {
  const allowed = new Set(
    catalog.map((item) => `${item.currency.toLowerCase()}:${Number(item.dayRateCents)}`),
  );
  const claims = [
    ...text.matchAll(/([$€£])\s*(\d+(?:[.,]\d{2})?)/g),
    ...text.matchAll(/(\d+[.,]\d{2})\s*([A-Za-z]{3})\b/g),
    ...text.matchAll(/\b([A-Za-z]{3})\s*(\d+[.,]\d{2})/g),
  ];
  for (const claim of claims) {
    let amount;
    let currencies;
    if (SYMBOL_CURRENCIES[claim[1]]) {
      amount = claim[2];
      currencies = SYMBOL_CURRENCIES[claim[1]];
    } else if (/^[A-Za-z]{3}$/.test(claim[1]) && /^\d/.test(claim[2])) {
      amount = claim[2];
      currencies = new Set([claim[1].toLowerCase()]);
    } else {
      amount = claim[1];
      currencies = new Set([claim[2].toLowerCase()]);
    }
    const cents = Math.round(Number(amount.replace(",", ".")) * 100);
    if (![...currencies].some((currency) => allowed.has(`${currency}:${cents}`))) {
      throw new ValidationError(`${label} contains a price not found in the catalog`);
    }
  }
}
