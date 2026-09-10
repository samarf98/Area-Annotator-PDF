# PDF Room Area Annotator

Full-stack tool: upload a PDF drawing, click **One Click** inside any room to get
its area, save the annotated drawing with a name + description, and reopen it
later with the markings intact.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| PDF rendering | **pdf.js** (client-side) | Renders the PDF to a canvas and exposes the page's text layer, which we reuse for scale detection (see below) |
| Area calculation | **Custom scanline flood-fill algorithm** (vanilla JS, no library) | Reads the actual rendered drawing pixels and measures the real enclosed shape of the room the user clicked in — not a bounding box, not an AI guess |
| Scale / units | **Auto-detected from the PDF's own title block** (regex for `N:M` on the text layer), with a manual two-point calibration fallback | No external service needed, works offline, and is exact when the drawing has a stated scale |
| Backend | **Node.js + Express** | Small, free-tier friendly, no build step |
| Storage | Local JSON file (`data/db.json`) for project metadata + `uploads/` folder for the PDFs | Zero external dependencies to get running; see "Persistence note" below for production |
| Frontend | Vanilla HTML/CSS/JS | No framework/build step, so it deploys as-is on any Node host |

## Why this approach differs from an OCR/Vision-API based tool

A common way to "read" a room's area off a drawing is to send the page image to
a cloud vision/OCR API and pattern-match printed text like `AREA = 98.95 SQ.M.`.
That works, but only when the label already exists on the sheet, costs a
per-call fee, needs an API key, sends the drawing to a third party, and adds
network latency.

This tool instead **measures the room geometrically**, the same way you would
with a planimeter: it floods outward in every direction from the clicked point
across open (non-wall) pixels, and stops naturally at drawn lines. It converts
the resulting pixel area into m² using the scale ratio that's already printed
on the sheet (parsed straight out of the PDF's text layer — no manual input
needed in the common case). That means it:

- Works on **any** PDF floor plan, even ones with no printed area labels
- Needs **no API key, no cost per lookup, no internet call** at inference time
- Runs entirely in the browser once the PDF is loaded

**Honest limitation:** because it fills to the nearest drawn line, if a
room's true leasable-area boundary follows a convention that isn't a drawn
line in that exact spot (e.g. measured to a shopfront centerline rather than
the visible glazing line), the computed figure can differ from the architect's
printed label. Verified against this drawing's own printed labels: some rooms
matched closely; Retail-1's computed enclosed area (~63 m²) undershot its
printed 98.95 m² label because the fill stopped at an internal reference line
short of the true shopfront. Two mitigations are built in: (1) if a fill leaks
through a gap (e.g. an open doorway) past a safety cap, it's reported rather
than silently returning a wrong number, and (2) manual calibration is available
if a drawing has no machine-readable scale text.

## Requirements coverage

1. ✅ Upload a PDF through the browser
2. ✅ "One Click" button — click a room, get its area
3. ✅ Save with Name + Description
4. ✅ List of previously saved drawings (name + description)
5. ✅ Reopen a saved drawing — markings are restored from stored pixel-run data, not re-computed
6. ⏳ Deploy — see below (requires your own free-tier account; can't be done on your behalf)

## Local setup

```bash
npm install
npm start
# open http://localhost:3000
```

## Deploying (Render, free tier)

1. Push this folder to a new GitHub repository.
2. Go to https://render.com → New → Web Service → connect the repo.
3. Build command: `npm install`  ·  Start command: `npm start`
4. Add a **Persistent Disk** (Render's free web services keep local disk between
   requests while the instance is alive; a disk survives redeploys too — do
   this so `data/` and `uploads/` aren't lost). Mount path: `/opt/render/project/src/data`
   and a second one for `uploads/` (or point both DATA_DIR/UPLOAD_DIR at one disk).
5. Deploy. Render gives you a live `https://your-app.onrender.com` URL.

(Railway and Fly.io work the same way — Node app + a persistent volume.)

## Possible future improvements

- Store filled-region masks more compactly (currently per-row pixel runs)
- Multi-page PDF support (currently annotates one page per project)
- Polygon-edit mode to manually correct a flood-fill that stopped short/long
