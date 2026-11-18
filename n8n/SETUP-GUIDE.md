# Super Simple Setup Guide
### Instantly Positive Reply → Phone Lookup → Email Alert

**What this robot does:** When someone replies to your cold email and gets
marked "Interested" in Instantly, this workflow wakes up, hunts for their cell
phone number in 4 different places, and emails the numbers to
**you@yourcompany.com** — usually within 2 minutes.

Follow every step in order. Don't skip ahead. Each part tells you what you
should see when you did it right. Total time: about 30 minutes.

---

## ✅ Before you start — gather your 4 keys

A "key" (API key) is like a password that lets the workflow use a service.
Collect all 4 first and paste them into a notes file. You'll use them in Part 3.

| # | Key | Where to get it |
|---|---|---|
| 1 | **Instantly key** | Open the file `.env` in the root of this project folder. Copy the value after `INSTANTLY_API_KEY=` |
| 2 | **LeadMagic key** | Same `.env` file. Copy the value after `LEADMAGIC_API_KEY=` |
| 3 | **Apify token** | Go to [console.apify.com](https://console.apify.com) → log in → click **Settings** (left sidebar, near the bottom) → **API & Integrations** → copy the token that starts with `apify_api_...` |
| 4 | **Gmail** | No key needed — you'll just log in with the you@yourcompany.com Google account when asked in Part 3, Step D |

You also need: an **n8n account** (either n8n Cloud at [n8n.io](https://n8n.io) or your own installed n8n) and the file
`instantly-positive-reply-phone-lookup.json` from this folder.

---

## Part 1 — Install two extra nodes in n8n (5 min)

n8n doesn't know how to talk to Instantly or Apify out of the box. These two
free add-ons teach it. **Do this BEFORE importing the workflow**, or the import
will show broken question-mark boxes.

1. Open n8n in your browser and log in.
2. Click **Settings** — it's the ⚙️ gear icon in the bottom-left corner.
3. In the menu on the left, click **Community nodes**.
4. Click the **Install** button (top right).
5. In the box that says "npm package name", type exactly:
   ```
   n8n-nodes-instantly
   ```
6. Check the little box that says you understand the risks (both of these are
   official, n8n-verified nodes — one is made by Instantly, one by Apify).
7. Click **Install**. Wait for the green success message.
8. Click **Install** again and repeat steps 5–7 with this name:
   ```
   @apify/n8n-nodes-apify
   ```

**✔️ You did it right if:** the Community nodes page now lists both
`n8n-nodes-instantly` and `@apify/n8n-nodes-apify`.

> **On n8n Cloud?** You may not see a "Community nodes" settings page. That's
> fine — Cloud installs verified nodes automatically. Just do Part 2, and if
> any node shows a "not installed" warning, click it and n8n will offer an
> **Install** button right there.

---

## Part 2 — Import the workflow (2 min)

1. In n8n, click **Overview** (top left) so you can see your workflow list.
2. Click the orange **Create Workflow** button, or the **⋯** menu → whichever
   your version shows.
3. Inside the new empty workflow, click the **⋯** (three dots) menu in the
   **top-right corner** of the screen.
4. Click **Import from File...**
5. Pick the file `instantly-positive-reply-phone-lookup.json` from this
   `n8n/` folder.

**✔️ You did it right if:** you now see a chain of 13 connected boxes, starting
with **Webhook** on the left and ending with **Send Alert to Me** on the
right. (Several boxes will show little red warning triangles — that's normal!
It just means the keys aren't plugged in yet. That's Part 3.)

6. Click **Save** (top right) so you don't lose it.

---

## Part 3 — Plug in your 4 keys (10 min)

Now we store each key inside n8n. In n8n, a stored key is called a
"**credential**". You make each one once, and the workflow uses it forever.

### Key A — Instantly

1. In your workflow, **double-click the box named "Get Lead Record"**.
2. Find the field near the top called **Credential to connect with**.
3. Click its dropdown → click **+ Create new credential**.
4. A form appears with one box: **API Key**.
5. Paste your **Instantly key** (key #1 from your notes). Nothing else — no
   extra words, no spaces.
6. At the top of the form, click the pencil ✏️ next to the name and rename it
   to exactly: `Instantly API`
7. Click **Save**. You should see a green **"Connection tested successfully"**
   message — that means the key works.
8. Close the node (click the X or anywhere outside it).

### Key B — Apify

1. **Double-click the box named "FastPeopleSearch"**.
2. Same dance: **Credential to connect with** → **+ Create new credential**.
3. In the **API Token** box, paste your **Apify token** (key #3).
4. Rename the credential to exactly: `Apify API`
5. Click **Save** → wait for the green success message → close the node.

### Key C — LeadMagic

LeadMagic has no official n8n node, so this one uses a generic type called
"Header Auth". Two extra boxes to fill, that's the only difference.

1. **Double-click the box named "LeadMagic Mobile"**.
2. **Credential for Header Auth** → **+ Create new credential**.
3. Fill in the two boxes EXACTLY like this:
   - **Name**: `X-API-Key`  ← type this exactly, capital X, capital A, capital K, with the dashes
   - **Value**: paste your **LeadMagic key** (key #2)
4. Rename the credential to: `LeadMagic`
5. Click **Save** → close the node.

### Key D — Gmail

1. **Double-click the box named "Send Alert to Me"**.
2. **Credential to connect with** → **+ Create new credential**.
3. Click the **Sign in with Google** button.
4. A Google window pops up. Choose the **you@yourcompany.com** account.
5. Google will ask for permission to send email — click **Allow / Continue**.
6. The window closes itself and n8n shows the account is connected.
7. Close the node.

> **Google window never appears?** Your browser is blocking pop-ups. Look for
> a blocked-pop-up icon in the address bar and allow pop-ups for n8n.

### Now connect the two leftover nodes

Two nodes share keys you already made — they just need to be pointed at them:

1. **Double-click "Get Latest Reply"** → in **Credential to connect with**,
   pick **Instantly API** from the dropdown (you made it in Key A). Close it.
2. **Double-click "TruePeopleSearch"** → pick **Apify API** from the dropdown.
   Close it.

3. Click **Save** (top right).

**✔️ You did it right if:** none of the boxes show red warning triangles
anymore.

---

## Part 4 — Tell Instantly where to send the signal (5 min)

The workflow starts when Instantly "rings its doorbell". We need to give
Instantly the doorbell's address (called a webhook URL).

### Get the address from n8n

1. **Double-click the very first box, "Webhook"**.
2. At the top you'll see two tabs: **Test URL** and **Production URL**.
3. Click **Production URL**.
4. Click the URL to copy it. It looks like
   `https://your-n8n.app.n8n.cloud/webhook/instantly-positive-reply-...`
5. Close the node.

### Give the address to Instantly

1. Open [app.instantly.ai](https://app.instantly.ai) and log in.
2. Click **Settings** (gear icon) → **Integrations** → **Webhooks**.
3. Click **Add Webhook** (or **Create Webhook**).
4. **URL**: paste the Production URL you just copied.
5. **Event**: choose **Lead is marked as interested**.
6. Leave campaign selection on **All campaigns** (or pick specific ones if you
   only want alerts for some).
7. Click **Save / Create**.

**✔️ You did it right if:** the webhook now appears in Instantly's webhook
list with your URL next to "Lead is marked as interested".

> Optional: repeat steps 3–7 to add a second webhook for the event **Lead
> status changed to Meeting booked** pointing at the same URL. The workflow
> accepts that one too.

---

## Part 5 — Test it before going live (5 min)

Let's fire a fake-but-real test so you see it work end to end.

1. In n8n, open your workflow and **double-click the "Webhook" box**.
2. Click the **Listen for test event** button. n8n now sits and waits, like a
   catcher's mitt.
3. In another browser tab, open Instantly → go to any campaign's **Leads** tab
   → pick a lead (ideally a real one from one of your uploaded lists, so it
   has industry/location data) → change their status to **Interested**.
4. Flip back to n8n. Within a few seconds the waiting screen fills with data —
   that's Instantly ringing the doorbell.
5. Now click **Execute workflow** (the play ▶️ button at the bottom of the
   canvas). Watch the boxes light up green one by one, left to right. The two
   people-search boxes take the longest (30–90 seconds each) — that's normal.
6. Check the **you@yourcompany.com** inbox. You should have an email with
   subject **"New Lead: (name) phone number"** with the company in bold and
   any numbers found, each with a % confidence score.

**If a box turns red**, click it — the error message tells you which service
complained. 9 times out of 10 it's a key pasted wrong in Part 3. Fix the
credential and press Execute workflow again.

---

## Part 6 — Turn it on for real (30 sec)

1. In the workflow, find the **Inactive / Active** toggle switch at the
   **top-right** of the screen.
2. Click it so it says **Active**.
3. Click **Save**.

**✔️ Done!** From now on, every time a lead is marked Interested in Instantly,
the phone-hunt runs by itself and the email lands in your inbox. You don't
need to keep n8n open.

---

## 💰 What each alert costs

| Thing | Cost |
|---|---|
| Apify (the 2 people-search sites) | about $0.22, hard-capped at $1 per lookup |
| LeadMagic | 5 credits **only if** it finds a mobile — misses are free |
| Everything else (Instantly, signature reading, Gmail) | free |

## 🔧 If something breaks later

| Problem | Fix |
|---|---|
| No email arrived after a lead was marked Interested | In n8n click **Executions** (left sidebar). Find the run, click it, and see which box is red. |
| "Unrecognized node type" boxes after import | You skipped Part 1 — install the two community nodes, then re-import. |
| Apify box red with "insufficient funds" | Add a payment method / credits at console.apify.com. |
| LeadMagic box red with 402 | LeadMagic credits ran out — top up. The email still sends with the other sources. |
| Email arrives but says "No phone numbers found" | That's not broken — nobody had a number for this person. It happens. |
| Instantly webhook shows failures | The workflow was toggled Inactive, or the URL changed. Re-copy the Production URL (Part 4) into Instantly. |

## 🤓 One nerdy note (safe to ignore)

The "Get Latest Reply" box is a plain HTTP box instead of the fancy Instantly
box **on purpose**: the official Instantly node currently filters out unread
emails when listing the inbox, and a brand-new positive reply is almost always
unread — so the fancy box would miss it. The plain box reads the exact same
data and uses the same Instantly key. Don't "fix" it. 🙂

## ⚖️ Be cool with the numbers

Cell numbers are personal data. Calling someone who just replied to you is
normal business. Don't feed these numbers into automated texting — that's
where TCPA law gets scary.
