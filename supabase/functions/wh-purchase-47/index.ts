// ============================================================
// wh-purchase-47 — inbound GHL $47-purchase webhook (MASTER §5, CONNECTION-MAP §5).
//
// Does: verify shared secret → confirm course product (paid OR flagged free trial) → idempotency check
//   → create/find auth user (no password) → upsert profile → enroll → segment=never_activated
//   → generate a one-time recovery token → write PORTAL_BASE_URL/setup?token=…&email=…
//     to GHL custom field portal_setup_url (buyer sets a password there; Phase 2.5)
//   → log to ghl_sync_log. Duplicate (same payment.transaction_id) → 200 no-op.
//
// OUT OF SCOPE this phase: GHL segment tag add (sync-segment-tag), events, ads.
// ============================================================

import { logSync, serviceClient, setContactCustomField } from "../_shared/ghl.ts";

const COURSE_47_SLUG = Deno.env.get("COURSE_47_SLUG") ?? "ecommerce-launch-blueprint";
const EXPECTED_47_PRODUCT_TITLE = Deno.env.get("EXPECTED_47_PRODUCT_TITLE") ?? "$47 The E-commerce Launch Blueprint";
// Lower-case substring that identifies the course in ANY of its product titles
// ($47, $9, free trial). Used alongside the exact-title check above.
const COURSE_TITLE_MATCH = (Deno.env.get("COURSE_TITLE_MATCH") ?? "e-commerce launch blueprint").toLowerCase();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // 1. Shared-secret header (MASTER §5).
  const secret = Deno.env.get("WH_PURCHASE_47_SECRET");
  if (!secret || req.headers.get("x-webhook-secret") !== secret) {
    return json({ error: "unauthorized" }, 401);
  }

  const db = serviceClient();

  let body: any;
  try {
    body = await req.json();
  } catch {
    // Log, don't vanish (MASTER §5 — every failure path is auditable).
    await logSync(db, { action: "wh-purchase-47", status: "failed", response: { error: "invalid_json" } });
    return json({ error: "invalid_json" }, 400);
  }

  // 2. Map payload.
  const payment = body?.payment ?? {};
  const email: string | undefined = (payment?.customer?.email ?? body?.email)?.toLowerCase?.();
  const contactId: string | undefined = body?.contact_id ?? payment?.customer?.id;
  const fullName: string = body?.full_name ?? [body?.first_name, body?.last_name].filter(Boolean).join(" ").trim();
  const realTransactionId: string | undefined = payment?.transaction_id;
  // Free-trial orders (the $0 page) carry no payment object. The GHL workflow for
  // that page sends custom data instead: offer=trial, product=<course name>.
  const customData = body?.customData ?? {};
  const offer: string | undefined = (customData?.offer ?? body?.offer)?.toString?.().toLowerCase?.();
  const lineTitle: string | undefined = payment?.line_items?.[0]?.title ?? customData?.product ?? body?.product;
  const totalAmount: number | undefined = payment?.total_amount;
  const amt = Number(totalAmount);

  if (!email || !contactId) {
    await logSync(db, {
      action: "wh-purchase-47",
      status: "failed",
      response: { error: "missing_required_fields", email, contact_id: contactId, transaction_id: realTransactionId },
    });
    return json({ error: "missing_required_fields", need: ["email", "contact_id"] }, 400);
  }

  // 3. Confirm this is our course. Paid path (unchanged): payment succeeded + a
  //    transaction id, any amount (coupons/discounts welcome). Trial path (new):
  //    no transaction id, amount 0 or absent, and the workflow flagged offer=trial.
  //    Product match accepts the exact $47 title, any "$47" title, or the course
  //    name itself, so the $9 and trial products pass without a code change.
  const titleOk =
    lineTitle === EXPECTED_47_PRODUCT_TITLE ||
    (lineTitle ?? "").includes("$47") ||
    (lineTitle ?? "").toLowerCase().includes(COURSE_TITLE_MATCH);
  const isPaid = payment?.payment_status === "succeeded" && !!realTransactionId;
  const isFreeTrial = !realTransactionId && offer === "trial" && (!Number.isFinite(amt) || amt === 0);
  if (!titleOk || !(isPaid || isFreeTrial)) {
    // Not our product / not paid / not a flagged trial — acknowledge so GHL doesn't retry forever.
    await logSync(db, { action: "wh-purchase-47:ignored", status: "success", response: { transactionId: realTransactionId, lineTitle, totalAmount, offer } });
    return json({ ok: true, ignored: "not_the_47_product" });
  }
  // One key drives the ledger + dedupe for both paths. Paid orders keep the real
  // transaction id; trial signups use a stable per-contact key.
  const transactionId: string = realTransactionId ?? `trial:${contactId}`;

  // 4. Idempotency — dedupe on payment.transaction_id (or the trial key).
  const { data: existing } = await db
    .from("ghl_sync_log")
    .select("id")
    .eq("action", "wh-purchase-47")
    .eq("status", "success")
    .filter("response->>transaction_id", "eq", transactionId)
    .limit(1);
  if (existing && existing.length > 0) {
    return json({ ok: true, deduped: true });
  }

  try {
    // 5. Create (or find) the auth user — magic-link sign-in, no password.
    const admin = db.auth.admin;
    const created = await admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { full_name: fullName, ghl_contact_id: contactId },
    });
    if (created.error && !/already|exists|registered/i.test(created.error.message)) {
      throw created.error;
    }

    // 5b. Repeat-call guard. If this person already went through the FULL flow for
    //     this course (a success ledger row exists for them), stop here: no new
    //     recovery token (which would invalidate the link they already have), no
    //     segment reset, no second welcome email. Covers the trial's day-3 charge,
    //     double purchases and GHL replays. Partial earlier failures (no success
    //     row yet) still fall through so GHL retries can complete the flow.
    {
      const { data: prof } = await db.from("profiles").select("user_id").eq("email", email).maybeSingle();
      if (prof?.user_id) {
        const { data: done } = await db
          .from("ghl_sync_log").select("id")
          .eq("action", "wh-purchase-47").eq("status", "success").eq("user_id", prof.user_id)
          .limit(1);
        if (done && done.length > 0) {
          await logSync(db, { user_id: prof.user_id, action: "wh-purchase-47:already_enrolled", status: "success", response: { transaction_id: transactionId, contact_id: contactId, email, offer } });
          return json({ ok: true, already_enrolled: true });
        }
      }
    }

    // 6. Generate a one-time recovery token and build our own /setup URL (Phase 2.5).
    //    We use the hashed_token (NOT the Supabase action_link) so the buyer lands
    //    on /setup to attach a password, instead of being auto-logged-in.
    //    The token is single-use: claimed at /setup via verifyOtp(type=recovery).
    const portalBase = Deno.env.get("PORTAL_BASE_URL")!;
    const link = await admin.generateLink({ type: "recovery", email });
    if (link.error) throw link.error;
    const userId = link.data.user?.id;
    const hashedToken = link.data.properties?.hashed_token;
    if (!userId || !hashedToken) throw new Error("generateLink returned no user/hashed_token");
    // email is a cosmetic, read-only prefill on /setup — the token is the security boundary.
    const setupUrl = `${portalBase}/setup?token=${hashedToken}&email=${encodeURIComponent(email)}`;

    // 7. Resolve the target course.
    const { data: course, error: courseErr } = await db
      .from("courses").select("id").eq("slug", COURSE_47_SLUG).single();
    if (courseErr || !course) throw courseErr ?? new Error(`course not found: ${COURSE_47_SLUG}`);

    // 8. Upsert profile · enroll · segment=never_activated.
    const up1 = await db.from("profiles").upsert(
      { user_id: userId, ghl_contact_id: contactId, email },
      { onConflict: "user_id" },
    );
    if (up1.error) throw up1.error;

    // Trial tier: a sub-$1 charge (the $0 offer's card-validation amount) is
    // tagged 'ghl_trial' so the portal can show "Unsubscribe" to those buyers
    // only. Full-price buyers keep 'ghl_purchase_47'.
    const isTrial = isFreeTrial || (Number.isFinite(amt) && amt < 1);
    const enr = await db.from("enrollments").upsert(
      { user_id: userId, course_id: course.id, source: isTrial ? "ghl_trial" : "ghl_purchase_47" },
      { onConflict: "user_id,course_id", ignoreDuplicates: true },
    );
    if (enr.error) throw enr.error;

    const seg = await db.from("user_segments").upsert(
      { user_id: userId, course_id: course.id, segment: "never_activated", changed_at: new Date().toISOString() },
      { onConflict: "user_id,course_id" },
    );
    if (seg.error) throw seg.error;

    // 9. Write portal_setup_url into the GHL contact custom field (a GHL call → log it).
    const fieldId = Deno.env.get("GHL_SETUP_URL_FIELD_ID");
    if (fieldId) {
      const ghl = await setContactCustomField(contactId, fieldId, setupUrl);
      await logSync(db, {
        user_id: userId,
        action: "set_portal_setup_url",
        status: ghl.ok ? "success" : "failed",
        response: { transaction_id: transactionId, contact_id: contactId, http_status: ghl.status, body: ghl.body },
      });
      if (!ghl.ok) throw new Error(`GHL custom-field write failed (${ghl.status})`);
    } else {
      await logSync(db, {
        user_id: userId,
        action: "set_portal_setup_url:skipped",
        status: "failed",
        response: { transaction_id: transactionId, reason: "GHL_SETUP_URL_FIELD_ID not configured", setup_url: setupUrl },
      });
    }

    // 10. Audit + idempotency ledger row.
    await logSync(db, {
      user_id: userId,
      action: "wh-purchase-47",
      status: "success",
      response: { transaction_id: transactionId, contact_id: contactId, email, course_id: course.id, user_id: userId },
    });

    return json({ ok: true, user_id: userId, course_id: course.id });
  } catch (err) {
    await logSync(db, {
      action: "wh-purchase-47",
      status: "failed",
      response: { transaction_id: transactionId, contact_id: contactId, email, error: String((err as Error)?.message ?? err) },
    });
    // 5xx so GHL retries with backoff (MASTER §5).
    return json({ error: "processing_failed", detail: String((err as Error)?.message ?? err) }, 500);
  }
});
