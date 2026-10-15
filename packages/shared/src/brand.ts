// Single source of truth for the product's display name. The JSON lives at the
// package root so non-TS consumers (rspack configs, sync scripts) can read it too.
import brand from "../brand.json" with { type: "json" };

export const APP_NAME = brand.productName;
export const LEGAL_NAME = brand.legalName;

// Short mark shown where the full name doesn't fit (e.g. the nav rail).
// Capital letters of the name ("MobileFlow" → "MF"), falling back to the
// first two characters for all-lowercase names.
export const APP_MONOGRAM = (
  APP_NAME.replace(/[^A-Z]/g, "").slice(0, 2) || APP_NAME.slice(0, 2)
).toUpperCase();
