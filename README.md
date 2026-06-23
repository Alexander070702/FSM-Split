# EvoSplit

A **single-file, fully static** SAP FSM extension. Workflow:

1. **Pick the long activity** to split (dropdown, loaded from FSM).
2. Choose the split mode — **by hours** (10 / 30 / 40) or **by percentage** (60 / 20 / 20).
3. For each work package, **pick a technician**.
4. **Split & assign** → one FSM activity per package is created under the same
   service call and assigned to the chosen technician.

The whole app is one file: `webapp/index.html`. No Component, no manifest, no
external view/controller, no build step — nothing that can fail to resolve on
GitHub Pages.

## What is tested (and what is not)

`npm test` runs `test/run.js`, which mocks the full UI5 API + the FSM shell +
`fetch`, executes the **real** application code, and verifies **21 checks**:
UI build without errors, shell handshake, loading technicians & activities,
activity-selection prefilling the form, split & assign in both modes (correct
durations 600/1800/2400 and 3600/1200/1200 min, correct `responsibles`
assignment, link back to the source activity), dry-run, and validation.

```
$ npm test
21 checks passed.
```

What this proves: the build and the split/assign/load logic are correct.
What it cannot prove from here: the **live HTTP calls** against your FSM tenant —
specifically **CORS** from the `github.io` origin and the exact **DTO versions**.
Those depend on your tenant and must be confirmed with the first real run
(see below). No browser/tenant is reachable from the build environment.

## Deploy (keeps the URL `…/FSM-Split/webapp/index.html`)

Replace the `webapp/` folder in your `FSM-Split` repo with the one from here, and
put a `.nojekyll` at the repo **root**:

```
FSM-Split/
├── .nojekyll          <- ADD at repo ROOT (stops Jekyll rendering README.md)
└── webapp/
    ├── index.html     <- EvoSplit (replaces the old app)
    ├── appconfig.json
    ├── config.json
    └── .nojekyll
```

Delete the old `Component.js`, `manifest.json`, `controller/`, `view/`, `lib/`,
`i18n/` — EvoSplit does not use them. Commit, push, wait ~1 min, hard-reload
(Ctrl+F5).

## Register in FSM

FSM Admin → Foundational Services → Extensions → Installed → Add Extension →
URL `https://alexander070702.github.io/FSM-Split/webapp/index.html`. Place it
where an activity / service call is selected so the form pre-fills.

## Behaviour

- **Standalone** (URL opened directly): yellow banner, computes the split, creates
  nothing (no FSM token outside the shell). Dropdowns are empty — expected.
- **Inside FSM**: green banner; activity + technician dropdowns fill from FSM;
  "Split & assign" creates and assigns. A **Dry run** switch computes without
  creating.

## Notes

- Assignment uses the activity field `responsibles: [<personId>]`. For a fully
  *scheduled* booking (time slot on the board), the productive version should
  additionally call the Service Management API `activity.plan(...)`.
- DTO versions live in `webapp/config.json`.
- CORS is the main risk of the backend-less approach — test it with the first
  real create; if blocked, a tiny proxy is the only remedy.
