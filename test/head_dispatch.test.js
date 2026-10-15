/* eslint-disable no-console */
/**
 * GDTF channel states acted on by a moving head.
 *
 * What is pinned: a GDTF fixture reaches the head in the units it was always
 * given -- dimmer 0 to 1, pan and tilt counted up from the lowest angle the
 * file gives, zoom in degrees, CMY by colour name, a wheel slot as a 0-based
 * index, a rotation in rpm, a strobe as an effect and a rate; a prism is
 * released by the channel that set it; a value no function covers holds the
 * head where it was.
 *
 * Usage:
 *   npm test
 */
import { zipSync, strToU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import readGdtf from '@/models/DMX/gdtf/gdtf_reader';
import DmxEngine from '@/models/DMX/gdtf/dmx_engine';
import HeadDispatch, { drawsFunction, headActsOn } from '@/models/DMX/gdtf/head_dispatch';
import { windowCentre, DEFAULT_ANIMATION_SYSTEM } from '@/plugins/visualizer/animation_wheel';

let failures = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} `
    + `got ${JSON.stringify(got)}  want ${JSON.stringify(want)}`,
  );
}

const parseXml = (s) => new DOMParser().parseFromString(s, 'text/xml');
const r = (n) => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : n);

/** A stand-in head that records what it is told. */
function recordingHead() {
  const log = [];
  const head = new Proxy({
    setWheelSlot: (...a) => log.push(['setWheelSlot', ...a.map(r)]),
    setWheelSlotRotation: (w, v) => log.push(['setWheelSlotRotation', w, Object.fromEntries(Object.entries(v).map(([k, x]) => [k, r(x)]))]),
    setPrism: (...a) => log.push(['setPrism', ...a]),
    setZoom: (...a) => log.push(['setZoom', ...a.map(r)]),
    setAnimation: (v) => log.push(['setAnimation', v && Object.fromEntries(Object.entries(v).map(([k, x]) => [k, r(x)]))]),
    setAnimationAngle: (v) => log.push(['setAnimationAngle', r(v)]),
    setAnimationRotation: (v) => log.push(['setAnimationRotation', r(v)]),
    setCorrectionFilter: (f, amount) => log.push(['setCorrectionFilter',
      f && Object.fromEntries(Object.entries(f).map(([k, x]) => [k, r(x)])), r(amount)]),
  }, {
    set(target, key, value) {
      log.push([key, typeof value === 'object' ? value : r(value)]);
      return true;
    },
  });
  return { head, log };
}

const channel = (offset, geometry, attribute, functions) => `
    <DMXChannel DMXBreak="1" Offset="${offset}" Geometry="${geometry}"><LogicalChannel Attribute="${attribute}">${functions}</LogicalChannel></DMXChannel>`;

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GDTF DataVersion="1.2"><FixtureType Name="Head" Manufacturer="Beam">
<AttributeDefinitions><Attributes>
  <Attribute Name="Pan"/><Attribute Name="Tilt"/><Attribute Name="Dimmer"/><Attribute Name="Zoom"/><Attribute Name="ColorSub_C"/>
  <Attribute Name="Gobo1"/><Attribute Name="Gobo1PosRotate"/><Attribute Name="Shutter1"/><Attribute Name="Shutter1Strobe"/><Attribute Name="Prism1"/>
  <Attribute Name="CTO"/><Attribute Name="CTB"/><Attribute Name="CTC"/><Attribute Name="Blade1A"/><Attribute Name="Effects1"/>
  <Attribute Name="AnimationWheel1"/><Attribute Name="AnimationWheel1Pos"/><Attribute Name="AnimationWheel1PosRotate"/>
  <Attribute Name="AnimationSystem1"/><Attribute Name="AnimationWheelSpin"/>
  <Attribute Name="Focus1"/><Attribute Name="Focus1Distance" PhysicalUnit="Length"/>
</Attributes></AttributeDefinitions>
<Wheels><Wheel Name="Gobo Wheel"><Slot Name="Open"/><Slot Name="Star"/></Wheel>
  <Wheel Name="Anim"><Slot Name="Open"/><Slot Name="Disc" MediaFileName="disc"/></Wheel></Wheels>
<PhysicalDescriptions><Filters><Filter Name="CTO" Color="0.4505,0.3728,37"/></Filters></PhysicalDescriptions>
<Geometries><Geometry Name="Base"><Axis Name="Yoke"><Axis Name="Head"><Beam Name="Lens"/></Axis></Axis></Geometry></Geometries>
<DMXModes><DMXMode Name="Mode" Geometry="Base"><DMXChannels>
${channel(1, 'Yoke', 'Pan', '<ChannelFunction Name="Pan" Attribute="Pan" DMXFrom="0/1" PhysicalFrom="-270" PhysicalTo="270"/>')}
${channel(2, 'Head', 'Tilt', '<ChannelFunction Name="Tilt" Attribute="Tilt" DMXFrom="0/1" PhysicalFrom="-135" PhysicalTo="135"/>')}
${channel(3, 'Head', 'Dimmer', '<ChannelFunction Name="Dimmer" Attribute="Dimmer" DMXFrom="0/1"/>')}
${channel(4, 'Head', 'Zoom', '<ChannelFunction Name="Zoom" Attribute="Zoom" DMXFrom="0/1" PhysicalFrom="40" PhysicalTo="4"/>')}
${channel(5, 'Head', 'ColorSub_C', '<ChannelFunction Name="Cyan" Attribute="ColorSub_C" DMXFrom="0/1"/>')}
${channel(6, 'Head', 'Gobo1', `<ChannelFunction Name="Gobo" Attribute="Gobo1" Wheel="Gobo Wheel" DMXFrom="0/1">
      <ChannelSet Name="Open" DMXFrom="0/1" WheelSlotIndex="1"/><ChannelSet Name="Star" DMXFrom="10/1" WheelSlotIndex="2"/>
    </ChannelFunction>
    <ChannelFunction Name="Spin" Attribute="Gobo1PosRotate" Wheel="Gobo Wheel" DMXFrom="128/1" PhysicalFrom="-360" PhysicalTo="360"/>`)}
${channel(7, 'Head', 'Shutter1', `<ChannelFunction Name="Closed" Attribute="Shutter1" DMXFrom="0/1"/>
    <ChannelFunction Name="Open" Attribute="Shutter1" DMXFrom="10/1"/>
    <ChannelFunction Name="Strobe" Attribute="Shutter1Strobe" DMXFrom="20/1" PhysicalFrom="1" PhysicalTo="20"/>`)}
${channel(8, 'Head', 'Prism1', `<ChannelFunction Name="Out" Attribute="NoFeature" DMXFrom="0/1"/>
    <ChannelFunction Name="3-facet" Attribute="Prism1" DMXFrom="128/1"/>`)}
${channel(9, 'Head', 'CTO', `<ChannelFunction Name="CTO" Attribute="CTO" Filter="CTO" DMXFrom="0/1"/>
    <ChannelFunction Name="Reset" Attribute="NoFeature" DMXFrom="200/1"/>`)}
${channel(10, 'Head', 'CTB', '<ChannelFunction Name="CTB" Attribute="CTB" DMXFrom="0/1" PhysicalFrom="5600" PhysicalTo="8000"/>')}
${channel(11, 'Head', 'CTC', `<ChannelFunction Name="No Function" Attribute="CTC" DMXFrom="0/1"/>
    <ChannelFunction Name="CTC" Attribute="CTC" DMXFrom="10/1" PhysicalFrom="3200" PhysicalTo="6000"/>`)}
${channel(12, 'Head', 'Blade1A', '<ChannelFunction Name="Blade1A" Attribute="Blade1A" DMXFrom="0/1"/>')}
${channel(13, 'Head', 'Effects1', '<ChannelFunction Name="FX" Attribute="Effects1" DMXFrom="0/1"/>')}
${channel(14, 'Yoke', 'CTO', '<ChannelFunction Name="CTO share" Attribute="CTO" DMXFrom="0/1"/>')}
${channel(15, 'Head', 'AnimationWheel1', `<ChannelFunction Name="Anim" Attribute="AnimationWheel1" Wheel="Anim" DMXFrom="0/1">
      <ChannelSet Name="Open" DMXFrom="0/1" WheelSlotIndex="1"/><ChannelSet Name="Disc" DMXFrom="128/1" WheelSlotIndex="2"/>
    </ChannelFunction>
    <ChannelFunction Name="Anim macro" Attribute="NoFeature" DMXFrom="200/1"/>`)}
${channel(16, 'Head', 'AnimationWheel1Pos', `<ChannelFunction Name="Anim index" Attribute="AnimationWheel1Pos" DMXFrom="0/1" PhysicalFrom="-180" PhysicalTo="180"/>
    <ChannelFunction Name="Anim spin" Attribute="AnimationWheel1PosRotate" DMXFrom="128/1" PhysicalFrom="-360" PhysicalTo="360"/>`)}
${channel(17, 'Yoke', 'AnimationSystem1', `<ChannelFunction Name="System" Attribute="AnimationSystem1" Wheel="Anim" DMXFrom="0/1" PhysicalFrom="0" PhysicalTo="100">
      <ChannelSet Name="Disc" DMXFrom="0/1" WheelSlotIndex="2"/>
    </ChannelFunction>`)}
${channel(18, 'Base', 'AnimationWheelSpin', '<ChannelFunction Name="Spin" Attribute="AnimationWheelSpin" DMXFrom="0/1" PhysicalFrom="720" PhysicalTo="-720"/>')}
${channel(19, 'Head', 'Focus1', `<ChannelFunction Name="Focus" Attribute="Focus1" DMXFrom="0/1" PhysicalFrom="0" PhysicalTo="1"/>
    <ChannelFunction Name="Auto focus" Attribute="Focus1Distance" DMXFrom="128/1" PhysicalFrom="5" PhysicalTo="15"/>`)}
</DMXChannels></DMXMode></DMXModes>
</FixtureType></GDTF>`;

const { fixtureType: type } = readGdtf(zipSync({ 'description.xml': strToU8(xml) }), { parseXml });
const engine = new DmxEngine(type, type.modes[0]);
const { head, log } = recordingHead();
const dispatch = new HeadDispatch(head, engine);
const write = (address, value) => {
  log.length = 0;
  dispatch.apply(engine.write(address, value));
  return log.slice();
};

check('pan counted from the lowest angle', write(0, 255), [['pan', 540]]);
check('tilt counted from the lowest angle', write(1, 128), [['tilt', r((128 / 255) * 270)]]);
check('dimmer 0 to 1', write(2, 255), [['intensity', 1]]);
check('zoom in degrees', write(3, 255), [['setZoom', 4, true]]);
check('CMY by colour name', write(4, 255), [['colorIntensity', { color: 'Cyan', colorBrightness: 1 }]]);
check('gobo slot, 0-based', write(5, 20), [['setWheelSlot', 'Gobo Wheel', 1]]);
check('gobo rotation in rpm', write(5, 255), [['setWheelSlotRotation', 'Gobo Wheel', { wheel: 'Gobo Wheel', rpm: 60 }]]);
check('shutter open', write(6, 15), [['strobeEffect', 'Open'], ['strobeRandom', false]]);
check('strobe effect and rate', write(6, 255), [['strobeEffect', 'Strobe'], ['strobeRandom', false], ['strobeFrequency', 20]]);
check('prism in', write(7, 200), [['setPrism', true, '3-facet Head_Prism1']]);
check('prism released by its channel', write(7, 0), [['setPrism', false]]);
check('CTO with a filter slides the filter in', write(8, 199), [['setCorrectionFilter', { color: '#ff9d73', transmission: 0.37, amount: 1 }, 1]]);
check('CTO filter halfway', write(8, 99), [['setCorrectionFilter', { color: '#ff9d73', transmission: 0.37, amount: r(99 / 199) }, r(99 / 199)]]);
check('CTO filter released by its channel', write(8, 250), [['setCorrectionFilter', null, 0]]);
check('CTB in kelvin is a white point', write(9, 255), [['colorTemperature', 8000]]);
check('CTC as a share with no filter draws nothing', write(10, 9), []);
check('CTC in kelvin is a white point', write(10, 255), [['colorTemperature', 6000]]);
check('focus as a share of the lens travel', write(18, 127), [['focus', 100]]);
check('focus distance in metres', write(18, 255), [['focusDistance', 15]]);

// What the guides call drawn is asked of the same dispatch.
const fnNamed = (name) => type.modes[0].channels
  .flatMap((ch) => ch.logicalChannels.flatMap((l) => l.functions)).find((f) => f.name === name);
check('drawn: framing blade', drawsFunction(fnNamed('Blade1A'), type), true);
check('drawn: CTO with a filter', drawsFunction(fnNamed('CTO'), type), true);
check('drawn: CTB in kelvin', drawsFunction(fnNamed('CTB'), type), true);
check('not drawn: CTO share with no filter', drawsFunction(fnNamed('CTO share'), type), false);
check('not drawn: effects', drawsFunction(fnNamed('FX'), type), false);
check('not drawn: no feature', drawsFunction(fnNamed('Reset'), type), false);
check('OFL capability the head acts on', headActsOn('ShutterStrobe'), true);
check('OFL capability the head ignores', headActsOn('Effect'), false);

// Animation wheels, in the ways the files write them.
check('animation disc in on its slot', write(14, 200 - 1), [['setAnimation', { wheel: 'Anim', slotNumber: 2, insertion: 1 }]]);
check('animation open slot', write(14, 10), [['setAnimation', { wheel: 'Anim', slotNumber: 1, insertion: 1 }]]);
check('animation disc out with its channel', write(14, 250), [['setAnimation', null]]);
check('animation index in degrees', write(15, 127), [['setAnimationAngle', 180]]);
check('animation spin in rpm', write(15, 255), [['setAnimationRotation', 60]]);
check('animation system: how far in', write(16, 51), [['setAnimation', { wheel: 'Anim', slotNumber: 2, insertion: r(0.2) }]]);
check('Ayrton AnimationWheelSpin, no wheel number', write(17, 255), [['setAnimationRotation', -120]]);
check('drawn: animation wheel', drawsFunction(fnNamed('Anim'), type), true);
check('not drawn: animation macro', drawsFunction(fnNamed('Anim macro'), type), false);

check('window at the start of its path', windowCentre(DEFAULT_ANIMATION_SYSTEM, 0), [1, 1]);
check('window passes P2 halfway', windowCentre(DEFAULT_ANIMATION_SYSTEM, 0.5).map(r), [0, 0.6]);
check('window at the end of its path', windowCentre(DEFAULT_ANIMATION_SYSTEM, 1).map(r), [-0.6, 0]);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
