/* eslint-disable no-console */
/**
 * The places Beam reads a GDTF file's words rather than its data, pinned.
 *
 * What is pinned: a shutter set named Closed shuts; a prism set named Open
 * with no slot takes the prism out and any other set names its prism; a
 * prism wheel's named slot is a prism without facets listed, with its
 * facets read from the name; a gobo wheel's slot with neither name nor image
 * is open whatever colour it has; a wheel channel's range that positions no
 * slot leaves the wheel on its first slot; a value between two named sets
 * with physical values runs on the line between them; and the range guide
 * says what the head does.
 *
 * Usage:
 *   npm test
 */
import { zipSync, strToU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import readGdtf from '@/models/DMX/gdtf/gdtf_reader';
import DmxEngine, { stateAt } from '@/models/DMX/gdtf/dmx_engine';
import HeadDispatch from '@/models/DMX/gdtf/head_dispatch';
import gdtfGuide from '@/models/DMX/gdtf/gdtf_guide';
import { wheelsForHead } from '@/models/DMX/gdtf/fixture_parts';
import {
  namesClosed, namesOpen, slotKind, prismFromText,
} from '@/models/DMX/gdtf/name_rules';

let failures = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(60)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

console.log('\nthe rules on their own');
check('Closed shuts', namesClosed('Closed'), true);
check('Shutter close shuts', namesClosed('Shutter close'), true);
check('Open does not shut', namesClosed('Open'), false);
check('Closedown is not a word for closed', namesClosed('Closedown'), false);
check('Open is open', namesOpen('Open'), true);
check('Open 1 is open', namesOpen('Open 1'), true);
check('Opening is not open', namesOpen('Opening'), false);
check('unnamed coloured gobo slot is open', slotKind('Gobo', { name: '', color: { x: 0.3, y: 0.3, Y: 100 } }), 'Open');
check('unnamed gobo slot with an image is a gobo', slotKind('Gobo', { name: '', mediaFileName: 'g1' }), 'Gobo');
check('named gobo slot without an image is a gobo', slotKind('Gobo', { name: 'Beam 1' }), 'Gobo');
check('unnamed colour slot stays a colour', slotKind('Color', { name: '', color: { x: 0.3, y: 0.3, Y: 100 } }), 'Color');
check('prism wheel named slot is a prism', slotKind('Prism', { name: '8-Facet Circular Prism' }), 'Prism');
check('prism wheel empty slot is open', slotKind('Prism', { name: '' }), 'Open');
check('facets listed make a prism anywhere', slotKind('Gobo', { name: 'x', facets: [{}, {}, {}] }), 'Prism');
check('frost slot', slotKind('Gobo', { name: 'Frost 1' }), 'Frost');
check('facets from text', prismFromText('8-Facet Circular Prism'), { facets: 8, linear: false });
check('linear from text', prismFromText('Linear Prism'), { facets: null, linear: true });

const parseXml = (s) => new DOMParser().parseFromString(s, 'text/xml');
const fn = (name, attribute, from, extra = '', sets = '') => `<ChannelFunction Name="${name}" Attribute="${attribute}" DMXFrom="${from}/1" ${extra}>${sets}</ChannelFunction>`;
const dmx = (offset, attribute, functions) => `
  <DMXChannel DMXBreak="1" Offset="${offset}" Geometry="Head"><LogicalChannel Attribute="${attribute}">${functions}</LogicalChannel></DMXChannel>`;
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2"><FixtureType Name="Spot" Manufacturer="Beam">
<AttributeDefinitions><Attributes>
  <Attribute Name="Pan"/><Attribute Name="Tilt"/><Attribute Name="Dimmer"/><Attribute Name="Shutter1"/>
  <Attribute Name="Gobo1WheelMode"/><Attribute Name="Gobo1"/><Attribute Name="Prism1"/><Attribute Name="Gobo1PosRotate"/>
</Attributes></AttributeDefinitions>
<Wheels>
  <Wheel Name="Gobo Wheel"><Slot Name="" Color="0.3127,0.3290,100.000000"/><Slot Name="Star" MediaFileName="star"/></Wheel>
  <Wheel Name="Prism Wheel"><Slot Name=""/><Slot Name="8-Facet Circular Prism"/></Wheel>
</Wheels>
<Geometries><Geometry Name="Base"><Axis Name="Yoke"><Axis Name="Head"><Beam Name="Beam" LuminousFlux="5000" PowerConsumption="200"/></Axis></Axis></Geometry></Geometries>
<DMXModes><DMXMode Name="Std" Geometry="Base"><DMXChannels>
  ${dmx(1, 'Dimmer', fn('Dimmer', 'Dimmer', 0))}
  ${dmx(2, 'Shutter1', fn('Shutter', 'Shutter1', 0, '', '<ChannelSet Name="Closed" DMXFrom="0/1"/><ChannelSet Name="Open" DMXFrom="32/1"/>'))}
  ${dmx(3, 'Gobo1', fn('Mode', 'Gobo1WheelMode', 0, 'Wheel="Gobo Wheel"', '<ChannelSet Name="BeamMode" DMXFrom="0/1" WheelSlotIndex="0"/>')
    + fn('Select', 'Gobo1', 20, 'Wheel="Gobo Wheel"', '<ChannelSet Name="Star" DMXFrom="20/1" WheelSlotIndex="2"/>'))}
  ${dmx(4, 'Prism1', fn('Prism', 'Prism1', 0, 'Wheel="Prism Wheel"', '<ChannelSet Name="Open" DMXFrom="0/1" WheelSlotIndex="0"/><ChannelSet Name="8 Facet prism" DMXFrom="128/1" WheelSlotIndex="0"/>'))}
  ${dmx(5, 'Gobo1PosRotate', fn('Rotate', 'Gobo1PosRotate', 0, 'PhysicalFrom="-1800" PhysicalTo="1800" Wheel="Gobo Wheel"',
    '<ChannelSet Name="CW Fast" DMXFrom="0/1" PhysicalFrom="1800" PhysicalTo="1800"/><ChannelSet Name="" DMXFrom="1/1"/>'
    + '<ChannelSet Name="Stop" DMXFrom="127/1" PhysicalFrom="0" PhysicalTo="0"/><ChannelSet Name="" DMXFrom="129/1"/>'
    + '<ChannelSet Name="CCW Fast" DMXFrom="255/1" PhysicalFrom="-1800" PhysicalTo="-1800"/>'))}
</DMXChannels></DMXMode></DMXModes>
</FixtureType></GDTF>`;
const { fixtureType: type } = readGdtf(zipSync({ 'description.xml': strToU8(xml) }), { parseXml });
const mode = type.modes[0];

console.log('\nwheel slots');
const wheels = wheelsForHead(type);
check('gobo wheel: coloured unnamed slot open, Star a gobo', wheels['Gobo Wheel'].slots.map((s) => s.type), ['Open', 'Gobo']);
check('prism wheel: open, then a prism', wheels['Prism Wheel'].slots.map((s) => s.type), ['Open', 'Prism']);

console.log('\nwhat the head is told');
const engine = new DmxEngine(type, mode);
const calls = [];
const head = new Proxy({}, {
  get(o, k) {
    if (k in o) return o[k];
    if (typeof k === 'string' && /^set[A-Z]/.test(k)) return (...a) => calls.push([k, ...a]);
    return undefined;
  },
  set(o, k, v) { calls.push([k, v]); o[k] = v; return true; },
});
const dispatch = new HeadDispatch(head, engine);
const write = (address, value) => {
  calls.length = 0;
  dispatch.apply(engine.write(address - 1, value));
  return calls.slice();
};
check('shutter 40 open', write(2, 40).find((c) => c[0] === 'strobeEffect'), ['strobeEffect', 'Open']);
check('shutter back to 0 closed', write(2, 0).find((c) => c[0] === 'strobeEffect'), ['strobeEffect', 'Closed']);
check('prism 128 in, 8 facets in its text', write(4, 128).find((c) => c[0] === 'setPrism'), ['setPrism', true, '8 Facet prism Head_Prism1']);
check('prism 0 out', write(4, 0).find((c) => c[0] === 'setPrism'), ['setPrism', false]);
check('gobo 20 in', write(3, 20).find((c) => c[0] === 'setWheelSlot'), ['setWheelSlot', 'Gobo Wheel', 1]);
check('wheel mode 0 leaves the wheel on its first slot', write(3, 0).find((c) => c[0] === 'setWheelSlot'), ['setWheelSlot', 'Gobo Wheel', 0]);

console.log('\nbetween named points');
const rotate = engine.channels.find((c) => c.offsets[0] === 5).functions[0];
check('named point CW Fast', stateAt(rotate, 0).physical, 1800);
check('halfway to Stop, still CW', Math.round(stateAt(rotate, 64).physical), 893);
check('Stop', stateAt(rotate, 127).physical, 0);
// 64 of the 127 values from Stop's end at 128 to CCW Fast at 255.
check('halfway to CCW Fast, CCW', Math.round(stateAt(rotate, 192).physical), -907);

console.log('\nthe guide says what the head does');
const guide = gdtfGuide(type, new DmxEngine(type, mode));
const text = (n) => guide.channels[n - 1].text;
check('shutter words', text(2), '0–31 closed · 32–255 open');
check('prism words', text(4), '0–127 off · 128–255 prism in (8 facet prism)');
check('rotation words', text(5), '0–126 spin fast→slow CW · 127–128 spin stop · 129–255 spin slow→fast CCW');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
