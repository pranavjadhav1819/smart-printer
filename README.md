# Smart Print

Pay-first printing for print and xerox shops. A customer scans the shop QR code, uploads files, sees an exact price, pays, and the paid job prints on the shop PC. No app install, no WhatsApp.

```
Customer phone  ->  Server (this project)  <-  Agent on shop PC  ->  Printer
 upload, pay        pages, price, payment       polls for paid jobs
                    verification, queue         prints, reports result
```

## Run the demo (5 minutes, no printer or payment account needed)

Needs Node.js 20 or newer.

```bash
npm install
cp .env.example .env          # defaults are demo-safe: PAYMENT_MODE=mock, DRY_RUN=1
npm start                     # terminal 1: server on http://localhost:3000
npm run agent                 # terminal 2: agent (saves "printed" PDFs into ./printed)
```

- Customer page: http://localhost:3000/s/shop1 (open on your phone using your PC's Wi-Fi address, and set BASE_URL to it so the QR works)
- Owner dashboard: http://localhost:3000/admin.html (PIN from .env, default 1234). Set rates, see the QR code, jobs and earnings.
- Run `npm test` to check the whole flow automatically (upload, price, failed payment, duplicate payment, print, file deletion).

### Demo script for funders (3 minutes)
1. Show the WhatsApp problem in one sentence.
2. Scan the QR, upload a PDF and a photo, show the automatic page count and price.
3. Tap Simulate failed payment: nothing prints. Then Simulate successful payment: job prints (show the PDF in ./printed or a real printer).
4. Open the dashboard: rates, earnings, job history.
5. Show your measured pilot numbers (see the proposal appendix).

## Go live at one shop

1. **Host the server** on a small VPS or a service such as Render or Railway. Set BASE_URL to the public https address. Set a strong OWNER_PIN and AGENT_TOKEN.
2. **Shop PC (Windows):** install Node.js, copy this folder, set SERVER_URL, the same AGENT_TOKEN and DRY_RUN=0 in .env, run `npm run agent`. Make it start with Windows (Task Scheduler). Linux and macOS use CUPS (`lp`).
3. **Word and PowerPoint files:** install LibreOffice on the server (set SOFFICE_PATH if needed). Without it, only PDF, JPG and PNG work.
4. **Real payments (Razorpay):**
   - Create a Razorpay account in the shop owner's name (their KYC, their bank account) and start with TEST keys.
   - In .env set PAYMENT_MODE=razorpay and the key id and secret.
   - In the Razorpay dashboard add a webhook to `https://YOUR-DOMAIN/api/razorpay/webhook` for `payment.captured` and `order.paid`, and put its secret in RAZORPAY_WEBHOOK_SECRET.
   - Payment is accepted only after the server verifies Razorpay's signature. Confirm current fees and rules with Razorpay.
   - Razorpay Checkout shows UPI apps on phones and a UPI QR on desktop. If you later add a counter tablet, look at Razorpay's QR Codes API.

## Put it on Vercel (pages) with the backend on another host

The pages (the `public` folder) are static, so they can live on Vercel. The server (`server.js`) needs a normal always-on Node host such as Render, Railway, Fly.io or a VPS, because it keeps files and orders and the shop agent connects to it.

1. **Backend first.** Push this project to GitHub. On Render (or similar) create a Web Service: build command `npm install`, start command `npm start`. Add the environment variables from `.env.example` (at least `OWNER_PIN`, `AGENT_TOKEN`, `PAYMENT_MODE`). Note the backend address, for example `https://smart-print.onrender.com`.
2. **Point the pages at the backend.** Edit `public/config.js` and set `window.API_BASE` to the backend address. Commit and push.
3. **Vercel.** Add New Project, pick the same repo, set **Root Directory** to `public`, Framework Preset **Other**, no build command. Deploy. `public/vercel.json` makes `/s/shop1` and `/admin` work.
4. **Connect the two.** On the backend set `BASE_URL` and `ALLOWED_ORIGIN` to your Vercel address (for example `https://smart-print.vercel.app`, no trailing slash) and redeploy. Preview URLs that Vercel generates for each branch are not allowed unless you add them to `ALLOWED_ORIGIN` (comma separated).
5. **Shop PC agent.** In its `.env` set `SERVER_URL` to the backend address (not the Vercel address), the same `AGENT_TOKEN`, and `DRY_RUN=0` for a real printer.
6. Open `https://YOUR-VERCEL-ADDRESS/admin` and print the QR code. Razorpay webhooks go to the backend address.

## What is included
- Page counting for PDF, JPG, PNG (and DOCX/PPTX with LibreOffice). Multiple files merge into one print job.
- Server-side price calculation from owner rates. Colour or black and white, one or both sides, copies, printer choice.
- Verified payments, exactly-once printing, unpaid orders expire after 15 minutes.
- Files deleted right after printing and in any case within 2 hours.
- Owner dashboard with rates, printer status, QR code, earnings and reprint for failed jobs.

## Not included yet (good next steps and R&D topics)
- Automatic colour or black-and-white detection per page, and page ranges.
- Several shops (the data model already uses a shop id; add shop sign-up, per-shop agent tokens and a real database such as Postgres or Supabase).
- Rate limiting, virus scanning of uploads, automatic refunds through the gateway API.
- The Razorpay code path is written from Razorpay's documented flow but has not been run against a live account. Test it in Razorpay test mode first.
