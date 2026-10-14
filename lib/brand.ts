// Single source of truth for the displayed brand name. Change this one value
// (or set NEXT_PUBLIC_BRAND_NAME in the environment) to rebrand the entire
// portal + admin in one place — no component edits required. The NEXT_PUBLIC_
// prefix makes the override available in both server and client components.
export const BRAND_NAME = process.env.NEXT_PUBLIC_BRAND_NAME || "The Academy";

// Trial-tier offer (the $0 / sub-$1 page). wh-purchase-47 tags those
// enrollments with this source; the account menu shows "Unsubscribe" only to
// them. The link is the Stripe customer portal login for that subscription.
export const TRIAL_ENROLLMENT_SOURCE = "ghl_trial";
export const UNSUBSCRIBE_URL =
  process.env.NEXT_PUBLIC_UNSUBSCRIBE_URL || "https://checkout.designmusketeer.com/p/login/5kAdSb2Iz4B5gxObII";
