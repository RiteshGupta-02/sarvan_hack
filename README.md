# UdhaarOS

A simple, single-owner shop ledger with Hindi/Hinglish chat and voice support. Ledger data is stored on Netlify, not in browser storage.

Live site: https://lambent-pixie-50e27c.netlify.app/

## Required Netlify setup

The Netlify site needs these environment variables. In **Project configuration → Environment variables**, add:

- `OWNER_PASSWORD`: a private password with at least 16 characters. Only the owner should know it.
- `SARVAM_API_KEY`: your Sarvam API key. If an older deploy already uses `API_KEY`, that name is still accepted.

Redeploy after saving the variables. No Supabase project or database setup is required. Netlify Blobs creates the persistent site-wide storage when the owner first signs in. It survives new deploys and can be accessed from another browser after signing in.

The owner signs in with `OWNER_PASSWORD`. The app uses a secure, HTTP-only session cookie; ledger, agent, transcription, and speech endpoints all require that session. There is one owner account and one shop ledger.

## Run locally

Install Node.js 20 or newer and Netlify CLI. Link this folder to the Netlify site so the local functions can access its Blobs store:

```sh
npm install
npm install -g netlify-cli
netlify link
netlify dev
```

For local-only environment variables, create an ignored `.env` in this folder:

```env
OWNER_PASSWORD=use_a_private_password_at_least_16_characters
SARVAM_API_KEY=your_sarvam_key
```

Never commit `.env` or put the Sarvam key in browser code. `.env` is ignored by Git; `.env.example` contains placeholders only.

## How it works

- Netlify Blobs stores customers and transactions persistently.
- The server validates writes, calculates balances from ledger entries, and rejects payments larger than the current balance.
- ETag-conditional writes prevent simultaneous requests from silently overwriting the ledger; the UI asks the owner to retry if another write wins.
- Sarvam classifies the latest request with recent chat context. It cannot calculate balances or write records directly.
- Failed AI requests show an explicit error and a Retry button. Retried ledger writes use the same idempotency ID.
- The bottom microphone sends a short recording to Saaras v4. Transcribed text is shown for review before sending. Voice replies use Bulbul v3 for its supported languages.
- No demo customers are preloaded. The owner starts with an empty ledger.

## Limitations

This is a small single-owner app, not a multi-user accounting system. Netlify Blobs is a key/value store rather than a relational database; the ledger is stored as one JSON record and is best suited to one shop with modest activity. Keep an independent backup of important records. Data previously held in the old browser demo is not imported.

## Quick checks

1. Sign in and add a customer.
2. Record credit and payment, then confirm the balance updates.
3. Try a payment larger than the balance; it must be rejected.
4. Reload and sign in from another browser; confirm the records persist.
5. Ask the assistant a balance question, then test a follow-up clarification.
6. Temporarily use an invalid Sarvam key; confirm the chat shows an error and Retry instead of silently stopping.
7. Use the microphone on the HTTPS site, review the transcript, then send it.
