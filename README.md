# UdhaarOS

A local, single-shop ledger with Sarvam Hindi/Hinglish voice chat, customer accounts, shop expenses, and an estimated profit report.

## Run on Windows

1. Install Python 3 if needed.
2. Copy `.env.example` to `.env` in this folder and add your Sarvam API key:

   ```env
   SARVAM_API_KEY=your_sarvam_api_key
   ```

   Keep `.env` private; Git ignores it. Never put the key in browser code or share it in chat.

3. Open PowerShell in this folder and run:

   ```powershell
   python server.py
   ```

4. Open **http://127.0.0.1:8765**. Allow microphone access. Click the page and hold **Space** to record; release Space to stop. You can also tap the large microphone. Each recording is transcribed and sent automatically. Replies appear as text and are spoken with Bulbul v3.
5. Return to PowerShell and press **Ctrl+C** to stop the app.

The app listens only on this computer. AI chat, voice transcription, and speech need an internet connection and send the relevant text or audio to Sarvam.

Run the local API/ledger checks with:

```powershell
python -m unittest discover -s tests -v
```

## Ledger, sample data, and backups

- Your real ledger is stored at `data\ledger.json` on this computer. It is not synced to Netlify, another computer, or a cloud backup. Keep a separate backup of this file.
- **View sample data** opens a separate practice ledger at `data\sample-ledger.json`; it never inserts fake customers or transactions into your real ledger. Sample names are labeled “Sample”. Switch back with **Return to my ledger**. You can experiment in either ledger without mixing them.
- Each credit/udhaar entry is treated as a sale. Optionally record the item's purchase cost on that entry. Record operating costs such as rent or electricity with **Add expense**.
- The profit figure is an estimate: recorded sale amounts minus entered item costs and shop expenses. If any sale is missing its purchase cost, the app labels the estimate incomplete; actual profit may be lower. Older sales without a cost stay marked as missing. Customer payments collect existing balances; they are not counted again as new sales.
- A payment may exceed the outstanding balance. The extra is saved as an advance and appears as a negative customer balance.

## Assistant

The AI interprets requests; local ledger code performs calculations and persists changes. You can ask it to add a customer, record a sale/payment/expense, check outstanding or advance balances, get a customer's lifetime totals and recent entries, summarize the last 7 days, estimate all-time profit, list customers/debtors, or ask general shop questions. Profit and customer reports are calculated from ledger records, not guessed by the model.

## Troubleshooting

- If a customer added through chat is not found, use **Add customer** and check for the visible error. The server rejects a blank or duplicate name.
- If Sarvam reports a configuration error, check the variable spelling and key in `.env`, save the file, then stop and restart `python server.py`.
- If Windows does not recognize `python`, install Python and enable **Add Python to PATH**.
- The microphone works in current browsers on localhost. If Space is typing into a text field, click a blank area of the page first, then hold and release Space.
- When a credit or payment is recorded for a named customer who is not in the ledger, the app creates that customer and records the requested amount in the same voice/chat workflow. Customer lookups do not create records.
