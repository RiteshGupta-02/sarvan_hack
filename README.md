# UdhaarOS

A small, mobile-friendly demo ledger for a neighborhood shop. It has customer balances, credit and payment entries, a basic activity/history view, and a Sarvam-powered Hindi/Hinglish/English command box with microphone input and spoken replies.

## Fastest setup

1. Create a free site on Netlify and deploy this folder from a GitHub repository.
2. In **Site configuration → Environment variables**, add `SARVAM_API_KEY` with your Sarvam key.
3. Trigger a deploy. No build command or dependency install is needed.
4. Open the deployed URL and try: “Ramesh ne 500 rupaye ka samaan udhaar liya.”

The Netlify functions keep the Sarvam key server-side. Add it as `SARVAM_API_KEY` in Netlify's site environment variables. For local development, the functions also accept `API_KEY`. Do not put the key in `app.js`, `index.html`, or a `NEXT_PUBLIC_*` variable. Netlify's free plan limits can change; check its current pricing before deployment.

## Run locally

The static page can be opened directly for the manual ledger. To test the AI function locally, install Node.js and Netlify CLI, then:

```sh
npm install -g netlify-cli
netlify dev
```

Set `SARVAM_API_KEY` in the local shell before running `netlify dev`. On Windows PowerShell:

```powershell
$env:SARVAM_API_KEY = "your-key"
netlify dev
```

## Demo storage limitation

This quick MVP saves entries in the current browser's `localStorage`. Data is not stored in a shared database, backed up, encrypted for production use, or available on another device. Clearing site data will erase it. The app seeds fictional sample customers on first open. **Use only fictional demo data; do not use this version for real shop accounts or customer financial records.**

## What is included

- Customer creation and search.
- Manual credit/payment recording, with paise precision and an overpayment check.
- Balances calculated from ledger entries, not AI responses.
- Demo totals, recent activity, customer history, and reset.
- Sarvam intent extraction through a Netlify serverless function. The browser validates customer identity and performs ledger calculations.
- The bottom microphone records up to 30 seconds, uses Saaras v4 to recognize regional-language speech, and fills the chat input for review before sending. Voice-originated replies are spoken with Bulbul v3 when the detected language is supported.
- Clear failure handling: if Sarvam is unavailable, its command is not saved; manual entry remains available.

Microphone use requires permission and HTTPS (localhost is allowed for development). Saaras automatically detects language; Bulbul v3 spoken replies support Hindi, Bengali, Tamil, Telugu, Kannada, Malayalam, Marathi, Gujarati, Punjabi, Odia, and English. Voice audio is sent to Sarvam for processing.

Not included: persistent cloud database, authentication, multi-shop access, phone-call voice agents, or production data security.

## Quick manual checks

1. On first load, confirm sample balances add up to ₹1,000.
2. Record a ₹500 credit for Ramesh; confirm his balance becomes ₹800.
3. Record a ₹200 payment for Ramesh; confirm his balance becomes ₹600.
4. Try a ₹10,000 payment for Ramesh; confirm it is rejected.
5. Reload the same browser; confirm entries remain.
6. Configure Sarvam and ask for the top debtor; check the answer against the displayed ledger.
7. Try the page at a narrow mobile width.
