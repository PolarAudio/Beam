/* eslint-disable no-console */
/**
 * Video inputs: what a device's turn and mirrors mean, and how a show saved
 * with connectors opens.
 *
 * The orientation convention, a decision rather than a discovery: output
 * space has its origin at the top-left of what the device shows, the picture
 * is turned **clockwise**, and the mirrors are applied afterwards in the
 * output's own axes. A quarter turn is the classic thing that looks plausible
 * and is mirrored, and a picture cannot be unit tested, so the corners are
 * pinned here.
 *
 * Usage:
 *   npm test
 */
import VideoInput, {
  orientedSample, migrateVideo, INPUT_KINDS, FILE_PREFIX,
} from '@/models/DMX/video_input';

let failures = 0;

function check(label, got, want) {
  const ok = Object.is(got, want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

/** Corners are exact in this maths, so an epsilon would hide a real error. */
function corner(u, v, orientation) {
  const at = orientedSample(u, v, orientation);
  return `${Math.round(at.x * 1000) / 1000},${Math.round(at.y * 1000) / 1000}`;
}

console.log('\n-- no turn --');
check('output top-left is the input top-left', corner(0, 0, {}), '0,0');
check('output top-right is the input top-right', corner(1, 0, {}), '1,0');
check('output bottom-left is the input bottom-left', corner(0, 1, {}), '0,1');

console.log('\n-- quarter turns, clockwise --');
{
  // Turning a picture clockwise carries its bottom-left corner to the top-left
  // of what you then look at.
  const cw = { rotation: 90 };
  check('90: output top-left is the input bottom-left', corner(0, 0, cw), '0,1');
  check('90: output top-right is the input top-left', corner(1, 0, cw), '0,0');
  check('90: output bottom-right is the input top-right', corner(1, 1, cw), '1,0');
  check('90: output bottom-left is the input bottom-right', corner(0, 1, cw), '1,1');
  check('180: output top-left is the input bottom-right', corner(0, 0, { rotation: 180 }), '1,1');
  check('270: output top-left is the input top-right', corner(0, 0, { rotation: 270 }), '1,0');
  check('270: output bottom-right is the input bottom-left', corner(1, 1, { rotation: 270 }), '0,1');
}

console.log('\n-- mirrors, in the output\'s own axes --');
check('mirror H swaps left for right', corner(0, 0, { mirrorH: true }), '1,0');
check('mirror H leaves the vertical alone', corner(0, 1, { mirrorH: true }), '1,1');
check('mirror V swaps top for bottom', corner(0, 0, { mirrorV: true }), '0,1');
check('both mirrors is a half turn', corner(0, 0, { mirrorH: true, mirrorV: true }), '1,1');

console.log('\n-- turn first, then mirror --');
// With the turn applied first, Mirror H mirrors what the viewer sees
// left-to-right. Applied the other way round it would mirror top-to-bottom.
check('90 + mirror H: top-left is the input top-left', corner(0, 0, { rotation: 90, mirrorH: true }), '0,0');
check('90 + mirror H: top-right is the input bottom-left', corner(1, 0, { rotation: 90, mirrorH: true }), '0,1');
check('and it is NOT 90 + mirror V', corner(0, 0, { rotation: 90, mirrorV: true }), '1,1');

console.log('\n-- an input --');
{
  const file = new VideoInput({ kind: INPUT_KINDS.FILE, file: 'Loop.mp4' });
  check('a file input is named after its file', file.name, 'Loop');
  check('and opens the file', file.feedName(), `${FILE_PREFIX}Loop.mp4`);
  const ndi = new VideoInput({ kind: INPUT_KINDS.NDI });
  check('an NDI input opens nothing until bound', ndi.feedName(''), '');
  check('and opens its sender once bound', ndi.feedName('DEV1 (Out 1)'), 'DEV1 (Out 1)');
  check('a binding is never saved with the show', JSON.stringify(ndi.showData).includes('DEV1'), false);
  const reloaded = new VideoInput(file.showData);
  check('an input reloads with its uid', reloaded.uid, file.uid);
  check('and its id', reloaded.id, file.id);
  const first = new VideoInput();
  const second = new VideoInput();
  check('two inputs never share a uid', first.uid !== second.uid, true);
}

console.log('\n-- a show saved with connectors --');
{
  const legacy = {
    videoConnectors: [
      {
        id: 1,
        name: 'HDMI 1',
        rect: {
          x: 0, y: 0, width: 1, height: 1,
        },
        rotation: 90,
        flipH: true,
      },
      {
        id: 2,
        name: 'HDMI 2',
        frame: { width: 1920, height: 1080 },
        rect: {
          x: 960, y: 0, width: 960, height: 1080,
        },
      },
    ],
    fixtures: [
      { id: 10, name: 'Wall', device: { source: 1, dimmer: 100 } },
      { id: 11, name: 'Side', device: { source: 2 } },
      { id: 12, name: 'Mover', channels: [] },
    ],
  };
  const { showData, binding, lostCrop } = migrateVideo(legacy, 'DEV1 (MadMapper - Out)');
  check('connectors are gone', showData.videoConnectors, undefined);
  check('one input takes their place', showData.videoInputs.length, 1);
  check('an NDI input, named after this machine\'s sender', showData.videoInputs[0].name, 'DEV1 (MadMapper - Out)');
  check('this machine\'s sender is bound to it', binding && binding.sender, 'DEV1 (MadMapper - Out)');
  check('to that input', binding && binding.uid, showData.videoInputs[0].uid);
  const wall = showData.fixtures[0].device;
  check('a whole-frame device moves to the input', wall.source, showData.videoInputs[0].id);
  check('and keeps the connector\'s turn', wall.rotation, 90);
  check('and its mirror', wall.mirrorH, true);
  check('and its own values', wall.dimmer, 100);
  check('a cropped device moves too', showData.fixtures[1].device.source, showData.videoInputs[0].id);
  check('and is named as having lost its crop', JSON.stringify(lostCrop), '["Side"]');
  check('a fixture with no device is untouched', showData.fixtures[2], legacy.fixtures[2]);
  check('what was read is not changed', legacy.fixtures[0].device.source, 1);
}

console.log('\n-- a show saved with a file --');
{
  const { showData, binding } = migrateVideo({ videoFile: 'Test card.png', fixtures: [] }, 'DEV1');
  check('becomes a file input', showData.videoInputs[0].kind, INPUT_KINDS.FILE);
  check('with that file', showData.videoInputs[0].file, 'Test card.png');
  check('and nothing to bind', binding, null);
  check('videoFile is gone', showData.videoFile, undefined);
}

console.log('\n-- a show with no video --');
{
  const { showData, binding, lostCrop } = migrateVideo({ fixtures: [{ id: 1, device: { dimmer: 50 } }] }, 'DEV1');
  check('gets no inputs', showData.videoInputs.length, 0);
  check('and nothing to bind', binding, null);
  check('and loses nothing', lostCrop.length, 0);
}

console.log('\n-- a show already on inputs --');
{
  const current = {
    videoInputs: [{
      id: 3, uid: 'abc', kind: 'ndi', name: 'Screen 1',
    }],
  };
  check('is left as it is', migrateVideo(current, 'DEV1').showData, current);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
