import { CreditCard } from "lucide-react";

// Brand icon that renders next to the card-number input. Maps Stripe's
// `brand` strings (from CardNumberElement's change event) to inline SVGs.
// Keeping them inline avoids a network hop and works in both light and
// dark themes — colors are baked in to match the brand identity.

export function BrandIcon({ brand }: { brand: string }) {
  switch (brand) {
    case "visa":
      return (
        <svg width="32" height="20" viewBox="0 0 48 30" aria-label="Visa">
          <rect width="48" height="30" rx="4" fill="#1A1F71" />
          <text
            x="50%"
            y="50%"
            dominantBaseline="central"
            textAnchor="middle"
            fontFamily="Helvetica, Arial, sans-serif"
            fontStyle="italic"
            fontWeight="700"
            fontSize="14"
            fill="#fff"
          >
            VISA
          </text>
        </svg>
      );
    case "mastercard":
      return (
        <svg width="32" height="20" viewBox="0 0 48 30" aria-label="Mastercard">
          <rect width="48" height="30" rx="4" fill="#1a1a1a" />
          <circle cx="20" cy="15" r="8" fill="#EB001B" />
          <circle cx="28" cy="15" r="8" fill="#F79E1B" />
          <path
            d="M24 9.5a8 8 0 010 11 8 8 0 010-11z"
            fill="#FF5F00"
          />
        </svg>
      );
    case "amex":
      return (
        <svg width="32" height="20" viewBox="0 0 48 30" aria-label="American Express">
          <rect width="48" height="30" rx="4" fill="#1F72CD" />
          <text
            x="50%"
            y="50%"
            dominantBaseline="central"
            textAnchor="middle"
            fontFamily="Helvetica, Arial, sans-serif"
            fontWeight="700"
            fontSize="9"
            fill="#fff"
          >
            AMEX
          </text>
        </svg>
      );
    case "discover":
      return (
        <svg width="32" height="20" viewBox="0 0 48 30" aria-label="Discover">
          <rect width="48" height="30" rx="4" fill="#fff" stroke="#e5e7eb" />
          <text
            x="50%"
            y="50%"
            dominantBaseline="central"
            textAnchor="middle"
            fontFamily="Helvetica, Arial, sans-serif"
            fontWeight="700"
            fontSize="8"
            fill="#FF6000"
          >
            DISCOVER
          </text>
        </svg>
      );
    case "diners":
    case "jcb":
    case "unionpay":
      return (
        <svg width="32" height="20" viewBox="0 0 48 30" aria-label={brand}>
          <rect width="48" height="30" rx="4" fill="#374151" />
          <text
            x="50%"
            y="50%"
            dominantBaseline="central"
            textAnchor="middle"
            fontFamily="Helvetica, Arial, sans-serif"
            fontWeight="700"
            fontSize="8"
            fill="#fff"
          >
            {brand.toUpperCase()}
          </text>
        </svg>
      );
    default:
      return <CreditCard size={20} strokeWidth={1.5} aria-label="Card" />;
  }
}
