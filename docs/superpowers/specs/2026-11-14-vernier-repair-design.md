# Vernier repair app: design

Date: 2026-11-14. Status: approved by the owner through chat and the clickable mockup (`mockup/ui-mockup.html`).

## Why

The company repairs Vernier hardware (sensors, LabQuest interfaces). Staff need one place to report a broken unit with photos and its S/N, and the technician (the owner) needs a queue and a searchable record of how each unit was fixed and checked.

## Goals

- Report a broken unit from a phone: product name with filtered dropdown and typo suggestions, mandatory photos, S/N read from the barcode photo and editable, symptom, urgent flag, optional customer name.
- Queue: urgent first (red card), then oldest first. Anyone can view. Technician takes the job, then closes it as fixed or not fixable with a repair log.
- History of closed jobs with search (name, S/N, customer), date range and status filter.
- Warn on a repeat S/N (open job: strong warning; past repairs: show them) and require confirmation.
- Email the owner on every new report, marked when urgent.
- Free to run, data kept long term.

## Non-goals

Running ticket numbers, image resizing, per-person accounts or roles, push notifications, OCR of printed text, prices.

## Constraints

- 7–10 internal users, one shared login (`admin` / `1234`, changeable in the sheet). The owner accepted the risk.
- Storage in the owner's personal Google account for now (15 GB shared with Gmail and Photos).

## Approaches considered

| | Approach | Verdict |
|---|---|---|
| A | Static PWA (HTML/JS) + Google Apps Script web app writing to Sheets and Drive | **Chosen.** Real PWA install, camera works on iOS and Android, free, data visible in Sheets. |
| B | Everything served from Apps Script HtmlService | Rejected: Google warning banner on personal accounts, sandboxed iframe, no real PWA. |
| C | Supabase or Firebase | Rejected: Supabase free projects pause after 7 days idle; Firebase Storage now needs billing. |

## Decisions

- Status flow: รอซ่อม → กำลังซ่อม → ซ่อมเสร็จ / ซ่อมไม่ได้. "Not fixable" requires a reason and goes to history.
- Photos: slot ① whole device (required), ② S/N label (required unless "no S/N"), up to 3 extra. Every slot offers camera or library.
- No S/N: field becomes "manual ID" (e.g. number written on the zip bag), optional, used for duplicate checks.
- Delete allowed in every status after confirmation; Drive photos go to trash (30-day recovery).
- Edit: reporter fields only; status is changed only through take/finish.
- Product list: 196 items from `vernier-thai.com/api_products.php`, lab books excluded, kept in the Products sheet for editing.
- Barcode: native `BarcodeDetector` when present (Android Chrome), ZXing otherwise (iPhone). Tries several sizes and a 90° rotation.

## Left to the builder (decided during build)

Fuzzy match uses bigram similarity, shows up to 3 guesses. Photos are shared "anyone with link" so `<img>` can load Drive thumbnails. Text cells are forced to plain text so S/N leading zeros survive.
