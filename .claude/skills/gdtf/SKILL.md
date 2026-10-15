---
name: gdtf
description: Work with GDTF fixture files in Beam -- read and explain one, review or repair one when Paul asks, survey how many files describe a feature, test a file in the running app side by side, fetch files from GDTF Share. Use whenever a .gdtf file, its description.xml, a GDTF attribute (CTO, Gobo1, Shutter1Strobe...) or Beam's GDTF pipeline (gdtf_reader, dmx_engine, head_dispatch) is the subject.
---

# GDTF in Beam

## Stance

- The file is the truth. Beam reads what a file says and draws that; it
  does not correct files or flag them in the UI ([[gdtf-spec-for-understanding]]).
- Review or repair a file only when Paul asks. A review states the fault, the
  XML, the XML it links to and the spec rule. A repair changes only what is
  certain; anything that needs a number from the manual stays as it is and
  goes on the open list.
- Rank faults by what they break for the user, not by whether they can be
  fixed. "This fixture cannot strobe in any software that reads the file"
  goes at the top even when the fix waits on a manual.
- State what Beam does with a fault only after reading the code that does
  it (`head_dispatch.js`), and test every channel in Beam, not only the
  repaired ones.
- Paul tests in Beam with his own eyes. Launching Beam and capturing frames
  passively is fine. Building a test scene or writing DMX into the app is done
  only when he asks, and only after `tools/dev/probes/show-state.js` says the
  open scene is saved.

## The spec

DIN SPEC 15800, kept at github.com/mvrdevelopment/spec (`gdtf-spec.md`, 3500
lines). Fetch it into the scratchpad and grep it:

```bash
curl -sL https://raw.githubusercontent.com/mvrdevelopment/spec/main/gdtf-spec.md -o "<scratchpad>/gdtf-spec.md"
grep -n "^#" "<scratchpad>/gdtf-spec.md"
```

Useful sections: Table 1 (value types), Attribute (Table 9), Wheel Slot
(Table 12), DMX Channel / Logical Channel / Channel Function / Channel Set
(Tables 58 to 61), Annex A and B (standard attributes with their Feature,
ActivationGroup, MainAttribute and PhysicalUnit), Annex C (allowed name
characters: no `.`), Annex E (wheel images).
Annex B lists `Prism(n)Pos` as AngularSpeed; its own text and `Gobo(n)Pos`
say Angle.

## How a file links

A `.gdtf` is a zip: `description.xml`, `thumbnail.png`, `wheels/*.png`,
`models/3ds|gltf|svg/*`. Everything inside links by **name**, matched
exactly; wheel slots link by **position**.

- `DMXChannel Geometry=` names a geometry. The channel's own name is
  `Geometry_Attribute` of its first logical channel; it is not written and
  must be unique in the mode.
- `LogicalChannel Attribute=` and `ChannelFunction Attribute=` name an
  `<Attribute>`. A logical channel carries the main attribute; its functions
  may be related ones (Gobo1 with Gobo1WheelSpin, Gobo1SelectShake). One
  attribute per geometry per mode.
- `InitialFunction=` is `ChannelName.LogicalAttribute.FunctionName`.
- `ChannelFunction Wheel=`, `Filter=`, `Emitter=` name nodes in Wheels and
  PhysicalDescriptions. With `Wheel=`, every ChannelSet shall have a
  `WheelSlotIndex`, counted from 1 in slot order. 0 is no slot.
- Ranges are implicit: a function or set gives `DMXFrom`; it ends one below
  the next sibling's `DMXFrom`, or at the channel's top.
- DMX values are `value/bytes`: `25/2` is 25 of 65535. `255/1` on a 16-bit
  channel is byte-mirrored to 65535; `255/1s` is shifted to 65280.
- PhysicalFrom/To are in the attribute's PhysicalUnit. Defaults 0 and 1, so a
  function left at 0 to 1 has stated nothing physical.

## Faults found in practice

From the Wisdom AAA MY SPOT review (2026-10-15) and the corpus:

- Names with a trailing space (`"BEAM "`, `"Focus "`), which then run through
  every channel name and InitialFunction on that geometry.
- ChannelSets pointing at the wrong slot, or at slot 0 on a wheel function.
- Strobe ranges written as ChannelSets inside one plain `Shutter1` function.
  The set names say strobe; the attribute says open/closed shutter, so every
  reader shows those ranges open. Each needs its own Shutter1Strobe /
  Shutter1StrobePulse / Shutter1StrobeRandom function with Hz.
- Selection, spin and shake in one function under the plain attribute
  (Gobo1 for all of it) instead of Gobo1 / Gobo1WheelSpin / Gobo1SelectShake.
- 16-bit presets written with 8-bit numbers (`25/2` meant as 10%).
- Highlight inside a strobe range.
- FieldAngle narrower than BeamAngle (they mean 10% and 50%).
- Two channels driving the same attribute on one geometry.
- Filters defined but never linked; leftovers from the file it was copied
  from (the revision list says "based on ...").
- Wheel images that are photographs (no transparent holder, tinted), or the
  same photo used for several gobos.
- CTO as a 0 to 1 share with no Kelvin and no filter link: nothing to draw.
  Elation's own Proteus Maximus and Hybrid files do this ([[gdtf-cto-patterns]]).

## Tools (in `scripts/`)

**check_gdtf.cjs** -- cross-reference check, reports only:

```bash
node .claude/skills/gdtf/scripts/check_gdtf.cjs <file.gdtf | description.xml> [wheelsDir]
```

Checks names, every link, slot indices, rising ranges, defaults inside their
function, duplicate set names, unused wheels/filters/emitters. Lines of the
form `set "X" points at slot n "Y"` compare the set's name with the slot's:
hints, often harmless (official files give hundreds). Missing links, slot 0
on a wheel and duplicate attributes are faults.

**survey.js** -- how many files describe one attribute family, read with
Beam's reader:

```bash
npx esbuild .claude/skills/gdtf/scripts/survey.js --bundle --platform=node --alias:@=./src --outfile=tools/dev/out/survey.cjs --log-level=error
node tools/dev/out/survey.cjs "^CT[OBC]" "\bCT[OBC]\b|\d{4}\s*K\b" public/profiles "C:/Users/Paul/Documents/Beatline/Beam/Library/Profiles"
```

**beam/** -- files side by side in the running app (only when Paul asks;
it replaces the open scene with a blank one, nothing is written to disk or
the library):

1. `tools/dev/probes/show-state.js` must say `saved: true`.
2. Copy the files under the repo (e.g. `tools/dev/out/<task>/`); Vite serves
   them through `/@fs/`.
3. In PowerShell:
   ```powershell
   $run = 'D:\Projects\beatline\Beam\.claude\skills\gdtf\scripts\beam\run.ps1'
   & $run -Script load -Params @{ files = @('tools/dev/out/t/orig.gdtf', 'tools/dev/out/t/fixed.gdtf') }
   & $run -Script shot -Params @{ set = @{ 'Dimmer' = 140; 'CTO' = 255 } } -Out D:\...\cto_on.png
   & $run -Script state -Match '^CT'
   ```
   Heads hang 3 m apart, 5 m up, left to right in file order, pointing at the
   floor. `shot` zeroes every channel, opens dimmer and shutter, centres
   pan/tilt, then applies `set` by channel name (from load's output).
4. Read the engine with `state` before believing a picture: it prints the
   active function, set and wheel slot per head. Pools at full dimmer
   saturate white; 40 to 140 shows colour and gobo detail.
5. Afterwards reopen Paul's scene: `tools/dev/stop.ps1 -Force`, then
   `tools/dev/launch.ps1 -Show "<his .beam>" -Foreground`.

## Repairing a file

- Unzip into its own scratchpad folder. description.xml is often CRLF: read
  it, normalise to LF for matching, write back with the original endings.
- Patch with a `.cjs` script, each anchor matched exactly once or stop
  (CLAUDE.md); never sed through Git Bash.
- Rezip with Python `zipfile` (ZIP_DEFLATED), same entry names.
- Run check_gdtf on before and after; the difference is the report.
- To add to the library: `window.library.importGdtf(path)` through
  `tools/dev/eval.ps1`, then `show.refreshGdtfFixtures()`. Without
  `{ replace: true }` it refuses a file of the same FixtureTypeID.

## Beam's pipeline

- `src/models/DMX/gdtf/gdtf_reader.js` -- zip and XML to a fixture type;
  `wheelImages` for the PNGs.
- `dmx_engine.js` -- `stateAt(fn, value)`: active function, set, physical.
- `head_dispatch.js` -- `gdtfAction` turns a state into what the head does,
  by attribute. Name heuristics only in `name_rules.js`.
- `fixture_parts.js` -- `wheelsForHead` (slot kind, filter colour scaled by
  transmission Y/100, gobo image), `cieToHex`.
- `src/plugins/visualizer/light.js` -- colour mix (`mixThrough`: emitters,
  wheel colour, CMY, correction filter), gobo atlas cells per
  `fixtureTypeId/mediaFileName`.
- `gdtf_guide.js` -- the channel range cards.

Animation wheels (`animation_wheel.js`): a disc image in its own atlas
(512 px cells, three blur levels) and a per-light table read by the beam and
pool shaders (`animationMask`). The gate shows a circle of `Radius` whose
centre runs along the spline P1-P2-P3 in the image's own coordinates as the
disc goes in; files without an `AnimationSystem` get Martin's values
(p1 1,1 / p2 0,0.6 / p3 -0.6,0 / r 0.35). Dispatch: `AnimationWheel(n)` picks
the slot (in = 1), `AnimationSystem(n)` also gives how far in (0-1 or 0-100);
a function that says in but names no slot uses the wheel's first slot with an
image; `Pos` holds an angle, and puts its slot in when its preset names one
(Robe); `PosRotate`, `Spin` and Ayrton's `AnimationWheelSpin` spin it.
Disc images load in the background, so a frame taken right after a fixture is
loaded shows no pattern yet.

Glass gobos are drawn as grey stencils, like any gobo image. A caustic
treatment of a water photo (contrast curve, no wash) was tried 2026-10-15 and
reverted: it looked wrong at every setting. Real water would need Beam to
generate the caustic itself. A gobo shot right after a wheel moves can catch
the wheel between slots, dark: settle it first.

What it draws for colour temperature: CTC/CTO/CTB with a range above 100 as
Kelvin (white point); a 0 to 1 (or 0 to 100) CTO/CTB with `Filter=` as that
filter slid in (`setCorrectionFilter`); a share with no filter, nothing.
Colour wheel slots take their filter's colour, else a Kelvin figure or a
colour word in the name. Not drawn: Highlight, Effects(n), filter links on
CMY, PhysicalUnit text.

## GDTF Share

Beam's own client holds Paul's login (`src/electron/gdtfshare.js`). From the
running app through eval: `window.gdtfShare.list(false)` (13,000 revisions,
cached; filter on `uploader === 'Manuf.'` for official files) and
`window.gdtfShare.download(rid, { manufacturer, fixture, revision })`, which
returns a temp path holding only the latest download, so copy it out each
time.

Test files from the Share are in `public/profiles` (shipped with the app):
Robe MegaPointe, BMFL Spot, 600 LEDWash; Martin Encore Performance CLD,
Aura XB; Clay Paky Mythos, Sharpy Plus; Ayrton Khamsin; Elation Proteus
Maximus; GLP impression X4; Vari-Lite VL2600; plus Tomshine and Wicked
Lasers.

## Writing it up

A review is an Artifact page: per fault the faulty XML (red), the XML it links
to (blue), the rule, the fixed XML (green); open items after; notes last.
PDF from the page: wrap it in a full HTML document with
`data-theme="light"`, add print rules last with `!important`
(`pre-wrap` on code lines, no `min-width` on the diagram), then

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu --user-data-dir="<scratchpad>\edge-profile" --no-pdf-header-footer --virtual-time-budget=8000 --print-to-pdf="<out>.pdf" "file:///<page>.html"
```

Plain and technical throughout (CLAUDE.md, Writing).
