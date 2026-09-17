// VISUTRA GST Billing — Firebase configuration
// -----------------------------------------------
// 1. Create a free Firebase project at https://console.firebase.google.com
// 2. Add a "Web app" inside that project (</> icon) — it gives you the object below.
// 3. Paste your real values in place of the placeholders.
// 4. Enable these in the Firebase console before this will work:
//      Authentication > Sign-in method > Google (enable)
//      Authentication > Sign-in method > Email/Password (enable)
//      Firestore Database > Create database (start in production mode)
//    Then paste the security rules from BILLING-SETUP.md into
//    Firestore Database > Rules.
const firebaseConfig = {
  apiKey: "AIzaSyDAvoUZexUkGmXZ4a-dkJ7KGjn3klNRwaw",
  authDomain: "visutra-billing.firebaseapp.com",
  projectId: "visutra-billing",
  storageBucket: "visutra-billing.firebasestorage.app",
  messagingSenderId: "239201374524",
  appId: "1:239201374524:web:ba8caab45dbd3e188b0e39"
};
// EmailJS (used to send the invoice email to the buyer — see BILLING-SETUP.md)
const EMAILJS_PUBLIC_KEY = "uvFM4OUqc4ZM_r3X4";
const EMAILJS_SERVICE_ID = "service_1g6knan";
const EMAILJS_TEMPLATE_ID = "template_ds08b1e";
// Separate template for marketplace order notifications (placed/accepted/rejected)
// — deliberately not the invoice template above, so its wording can stay
// order-specific. See BILLING-SETUP.md "Order email notifications" for the
// exact EmailJS template to create and paste the ID in below.
const EMAILJS_ORDER_TEMPLATE_ID = "template_r7i6awt";
// Google reCAPTCHA v2 ("I'm not a robot" checkbox) — shown on login/signup to
// deter bots. Get a free site key at https://www.google.com/recaptcha/admin
// (register your domain "visutra.in", choose reCAPTCHA v2 "Checkbox").
const RECAPTCHA_SITE_KEY = "6LdBgJYtAAAAACIxZhjWF8Y0KLtG-DWyMAYAGZ0r";
firebase.initializeApp(firebaseConfig);
// Not every page that includes this shared config also loads the Firebase Auth
// SDK (e.g. invoice-view.html is a public page with no login, so it only loads
// the app + firestore scripts). Calling firebase.auth() there would throw and
// abort this whole file before `db` below ever gets defined — guard it instead.
const auth = typeof firebase.auth === 'function' ? firebase.auth() : null;
const db = firebase.firestore();
