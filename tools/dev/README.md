# Dev tools

Scripts for running Beam's dev build and looking at it from outside: start
and stop it, read its state, capture it, time it, and compare pictures by
numbers. Windows; PowerShell 5.1 and Git Bash. Output goes to `out/`, which
git ignores.

| Script | What it does |
|---|---|
| `launch.ps1 [-Show path.beam] [-Foreground]` | Starts the dev build detached, DevTools on port 9223, log in `out/app.log`. Background by default: no maximise, no focus. |
| `stop.ps1 [-Force]` | Stops it by executable path. Refuses while the open show has unsaved changes. |
| `eval.ps1 -File x.js` or `-Expr "..."` | Runs JavaScript in the renderer and prints the value. |
| `screenshot.ps1 -Out file.png` | Captures the window, in front or not. |
| `perf-sample.sh [label] [log]` | GPU and CPU time over ten fresh `[perf]` lines. |
| `npx electron png-tool.cjs diff\|crop\|stack\|row ...` | Compares and cuts PNGs; `diff` says how many pixels changed. |
| `probes/show-state.js` | Open show, saved or not, item counts. |
| `probes/camera-state.js` | Camera kind, place, target, lens shift. |
| `regress/run.ps1 -Label x [-Against y]` | Visual regression set: restarts Beam, renders every scene at four haze levels, stops it, diffs against another set. |

## Regression set

`regress/` builds its scenes from the blank show each time -- shipped OFL
profiles and generic kinds, nothing from the user's library -- so it is the
one place a script drives the scene. Movers (front and looking up into the
beams), LED bar and panel, laser, projector and strobe, each at haze 0, 25,
50 and 100, into `out/regress/<label>/`.

- The clock is frozen and stepped by hand, turbulence is 0, the canvas is
  1280 x 720 and the room and bloom are pinned, so two runs of the same code
  match to the pixel. A step not meant to change a scene must diff at 0.
- It restarts the app and loads its own scenes over whatever was open; run it
  only when nobody is working in Beam. `preferences.json` and
  `window-state.json` are copied aside and put back.
- `capture.ps1` takes a single shot from an app already running the prelude.

## How these are used

- Look, do not drive. Reading state, selecting, screenshots and timing are
  fine. Adding to the scene, moving its items, playing content or sending DMX
  is the user's.
- Check `probes/show-state.js` before anything that reloads or restarts the
  app -- a source edit hot-reloads it -- and do not go ahead over unsaved
  changes.
- Open a `.beam` by launching with `-Show`. Handing a file to a running Beam
  skips mounting its bundled library, and a save afterwards drops it.
- Measure: `png-tool.cjs diff` for "did it change", `row` for an edge or a
  falloff, `perf-sample.sh` before and after for cost.
