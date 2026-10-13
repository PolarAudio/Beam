# Video inputs: architecture review

Status: draft for review, 2026-10-11. Nothing here is built.

## Decision

Beam receives video; it does not compose it. Composing, slicing and
blending are the media server's job (Resolume, MadMapper). Beam models the
cabling: which picture reaches which device.

- An **input** is one NDI stream or one file.
- Each **display or projector** picks an input and shows all of it.
  Any number of devices can share one input, as a distribution amplifier
  does.
- **Orientation, cropping and scaling** belong to the device, and only
  where its make and model has them: a projector's ceiling and rear modes,
  a panel's rotation, an aspect mode or zoom, an LED processor's scaling.
  Each is a control in the device's definition, fixed, adjustable or
  DMX, like any other; a model that lacks one does not list it.
- **Connectors and slicing are removed.** MadMapper and Resolume both send
  one NDI stream per output, so a crop inside Beam is not needed. A
  splitter stage can come back later if a rig drives devices through a
  hardware splitter.

## Why

- Slicing duplicates the media server and shows a layout Beam made up,
  not the one the rig plays.
- One source for the whole scene cannot show a Resolume rig, which sends
  a stream per output.
- An atlas looks perfectly in sync inside Beam while the real chain
  (splitters, unlocked GPU outputs, projector processing) is not. Real
  timing belongs in a stated delay model, below, not in the transport.

## What exists today

| Layer | File | One source or many |
|---|---|---|
| NDI receivers | `electron/ndi.js` | many, by handle |
| Renderer feeds | `video_feed.js` (NDI and file) | many, decoded every frame by `video_decode.js` |
| Router | `video_router.js` | one current feed |
| Connectors | `video_connector.js`, `show.videoConnectors` | regions of the one feed |
| Displays | `display.js` | the router's one feed, connector UVs from `sampleAt` |
| Projectors | `projector.js`, `projector_pass.js` | the router's one feed; one picture texture for all projectors; rotation and mirroring ignored |
| Show | `show.model.js` | `videoFile` for a file; NDI sender in the `videoSource` preference |
| Window | `popup.video.vue` | source picker and connector editor |

## Model

**Input** (show data): `{ id, name, kind: 'ndi' | 'file', file }`.
`name` is what devices and the window show, such as "Resolume screen 1".
A file input names its file, which travels with the show as `videoFile`
does now.

**Binding** (machine preference): input id to NDI sender name. A sender's
name means nothing on another computer, so it stays out of the show, as
`videoSource` does now. An unbound NDI input shows as unbound on the
devices.

**Device** (fixture settings): `source` names an input id instead of a
connector id. Picture features, where the definition lists them:
orientation (rotation 0, 90, 180, 270 and mirror H/V), crop (a rectangle
of the input) and scale (fit, fill, stretch or native, and a zoom factor;
fit puts a 1:1 input in a 16:9 picture with black bars at the sides).
Processing delay sits in the same definition.

**Names.** "HDMI n" was the default name of a connector, a slice of the
frame. An input's default name comes from what it carries, the sender's or
the file's name, and can be changed. HDMI stays on the device side: a
projector's own input ports (HDMI 1, HDMI 2, HDBaseT), chosen by its
Source Select channel. If Beam models them later, the ports are a device
feature listed per model, and each port names the input plugged into it.

## Changes by module

- **`video_router.js`**: from one current feed to `feedFor(inputId)`.
  It opens a feed when the first visible device uses the input and closes
  it when the last one goes, so streams nobody shows cost nothing. Each
  feed is opened through `VideoFeed.open`, which already shares one
  receiver between holders.
- **`video_feed.js`**: unchanged in principle. NDI and file feeds already
  carry the same fields.
- **`display.js`**: asks for its own input's feed. Its UVs come from the
  device's rotation and mirroring over the whole frame; `sampleAt` moves
  from the connector to a small helper both device kinds share.
- **`projector.js` / `projector_pass.js`**: a picture per projector. See
  below.
- **`show.model.js`**: `inputs` replace `videoConnectors` and `videoFile`;
  Export collects the files of file inputs.
- **Preferences**: `videoSource` becomes a map of input id to sender.
- **`video_connector.js`**: removed after migration.

## Projectors with different pictures

The pass takes one `picture` sampler for every projector. Options:

1. **Texture slots**: a fixed number of samplers, each projector given a
   slot index. Simple, cheap, and the slot count caps distinct inputs on
   projectors at once (8 is plenty for a rig).
2. **Array texture**: one layer per input. Array textures have read as
   zero on this machine before (the gobo atlas), so this needs proving
   first, and every input would share one size.

Built: slots, one per projection. The pass draws at most six projectors
(`MAX_PROJECTIONS`), so six samplers cover every case and projectors on one
input bind the same texture. Samplers cannot be indexed by a loop variable,
so they are named and chosen by comparison; the surface read takes explicit
gradients from the world position's derivatives, which also fixed the
projected picture's moire (the old read sat in per-pixel control flow and
fell back to the full-size level).

Measured on six projectors in 50% haze: 2.42 ms GPU before, 2.29-2.32 ms
after with one input, 2.28 ms with two. Regression set: every scene at 0
except the projector, where the test card's grid now averages instead of
aliasing.

## Bandwidth

Each NDI receiver delivers up to 30 frames a second (`DEFAULT_MAX_FPS`),
1080p is about 8 MB a frame as RGBA. Work scales with pixels, so four
1080p streams cost about what one 4K atlas does. Opening only inputs a
visible device uses keeps idle streams free. To measure: CPU and gpuMs
with 1, 4 and 8 streams from MadMapper.

## Delay model (parked, 2026-10-11)

Not built. Left out of the plan on 2026-10-11: no value in simulating it
yet. Kept here in case it is asked for.

Real sync problems come after the media server: unlocked GPU outputs,
splitters, projector and processor latency. If Beam should show them:

- **A Delay (ms) control** in display and projector definitions, fixed or
  adjustable like the picture controls, from the spec sheet or a
  measurement. Milliseconds rather than frames, since spec sheets give
  either and frames depend on the refresh rate; the panel can show the
  frame count at 60 Hz beside it.
- **A short history per input.** The decode step keeps a ring of recent
  frames, each stamped with its arrival time, instead of one. A device with
  50 ms of delay shows the newest frame at least 50 ms old. Decoding costs
  nothing more: each frame goes into the next slot.
- **Memory only where used.** A 1080p frame is about 8 MB; a ring is only as
  deep as the longest delay on that input (100 ms at 60 fps is about 7
  frames, ~56 MB). An input with no delayed device keeps one frame.
- **Splitters later:** a delay shared by every device behind it, added to
  each device's own. Needs a way to say which devices sit behind which
  splitter.

It shows devices out of step with each other, not lag against the media
server's timeline or audio: Beam has no clock to compare with. Fixed
numbers, predictable, never measured from the transport.

## Migration of saved shows

- Each show gets one input: its file if `videoFile` is set, otherwise an
  NDI input bound to this machine's `videoSource`.
- A device on a connector that covers the whole frame moves to that input
  and takes the connector's rotation and mirroring.
- A device on a smaller connector moves to the input and shows the whole
  frame. Beam says which devices lost a crop, once, on load.
- Shows saved after migration no longer carry connectors.

## The window

Redesigned after this lands. It becomes a list of inputs (name, kind,
sender or file, live status, the devices using it) with a preview of the
selected one. The canvas, connector drawing, Split and Snap go.

## Order of work

1. Router per input, devices pick inputs, migration. Displays first:
   no shader change.
2. Projector pass with slots, measured. Done.
3. Device picture features: orientation, crop and scale as controls in the
   display and projector definitions.
4. Window.
5. Delay model: parked, see above.

## Open questions

1. The input names a device shows: the input's own name only, or with the
   sender or file behind it?
2. Slot count for projectors: 8 enough?
3. Should an unbound NDI input fall back to the first sender found, or
   stay dark until bound? Proposed: stay dark, so nothing switches on
   behind the user's back.
