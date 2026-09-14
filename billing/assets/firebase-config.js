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
const EMAILJS_SERVICE_ID = "service_7ufblgf";
const EMAILJS_TEMPLATE_ID = "template_ds08b1e";
// Google reCAPTCHA v2 ("I'm not a robot" checkbox) — shown on login/signup to
// deter bots. Get a free site key at https://www.google.com/recaptcha/admin
// (register your domain "visutra.in", choose reCAPTCHA v2 "Checkbox").
const RECAPTCHA_SITE_KEY = "6LdBgJYtAAAAACIxZhjWF8Y0KLtG-DWyMAYAGZ0r";
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
