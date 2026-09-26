// VISUTRA — backend configuration (Supabase — no Google services)
// ---------------------------------------------------------------
// The file keeps its old name so every page still loads it the same way.
// Pages load, in order:
//   1. supabase-js           (https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2)
//   2. vt-firebase-compat.js (gives the pages the same API they were written for)
//   3. this file
// The publishable key is meant to be public — your data is protected by the
// Row Level Security rules in supabase/schema.sql, not by hiding this key.
const VT_SUPABASE_URL = "https://mxannyoulyhenvmrpzfr.supabase.co";
const VT_SUPABASE_KEY = "sb_publishable_HAS2L4NPD0u-elLamwmlww_lazuij02";

// EmailJS (invoice + order emails). Point the EmailJS service at your
// GoDaddy mailbox (support@visutra.in) — see SUPABASE-SETUP.md, step 5.
const EMAILJS_PUBLIC_KEY = "uvFM4OUqc4ZM_r3X4";
const EMAILJS_SERVICE_ID = "service_1g6knan";
const EMAILJS_TEMPLATE_ID = "template_ds08b1e";
const EMAILJS_ORDER_TEMPLATE_ID = "template_r7i6awt";

// reCAPTCHA (a Google service) is switched off. Supabase Auth has its own
// rate limiting against bots.
const RECAPTCHA_SITE_KEY = "";

firebase.initializeApp({ supabaseUrl: VT_SUPABASE_URL, supabaseKey: VT_SUPABASE_KEY });
const auth = firebase.auth();
const db = firebase.firestore();
