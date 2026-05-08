import Stripe from "stripe";
import { env } from "../env.js";

let _stripe: Stripe | null | undefined;

export function getStripe(): Stripe | null {
  if (_stripe !== undefined) return _stripe;
  if (!env.STRIPE_SECRET_KEY) {
    _stripe = null;
    return null;
  }
  _stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
  return _stripe;
}

export function priceIdForPlan(planId: string): string | null {
  switch (planId) {
    case "bohio":
      return env.STRIPE_PRICE_BOHIO ?? null;
    case "yucayeque":
      return env.STRIPE_PRICE_YUCAYEQUE ?? null;
    case "cacique":
      return env.STRIPE_PRICE_CACIQUE ?? null;
    default:
      return null; // naboria (free) and unlimited (internal) have no price
  }
}

export function planForPriceId(priceId: string): string | null {
  if (priceId === env.STRIPE_PRICE_BOHIO) return "bohio";
  if (priceId === env.STRIPE_PRICE_YUCAYEQUE) return "yucayeque";
  if (priceId === env.STRIPE_PRICE_CACIQUE) return "cacique";
  return null;
}
