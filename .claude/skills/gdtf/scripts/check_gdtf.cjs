// Cross-reference check of a GDTF file: every link resolves, wheel slot
// indices exist, DMX ranges rise, names are clean. Reports, changes nothing.
// Usage: node check_gdtf.cjs <file.gdtf | description.xml> [wheelsDir]
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '../../../..');
const { DOMParser } = require(path.join(repo, 'node_modules/@xmldom/xmldom'));
const { unzipSync, strFromU8 } = require(path.join(repo, 'node_modules/fflate'));

const [, , file, wheelsArg] = process.argv;
let text;
let images = null;
if (/\.gdtf$/i.test(file)) {
  const zip = unzipSync(new Uint8Array(fs.readFileSync(file)));
  text = strFromU8(zip['description.xml']);
  images = new Set(Object.keys(zip).filter((k) => k.startsWith('wheels/')).map((k) => k.slice(7).toLowerCase()));
} else {
  text = fs.readFileSync(file, 'utf8');
}
const wheelsDir = wheelsArg || null;
const hasImage = (media) => (images
  ? images.has(`${media}.png`.toLowerCase())
  : fs.existsSync(path.join(wheelsDir, `${media}.png`)));
const doc = new DOMParser().parseFromString(text, 'text/xml');
const els = (root, tag) => Array.from(root.getElementsByTagName(tag));
const at = (e, a) => (e.hasAttribute(a) ? e.getAttribute(a) : null);
const out = [];
const fault = (where, msg) => out.push(`${where}: ${msg}`);

const attributes = new Map(els(doc, 'Attribute').map((a) => [at(a, 'Name'), a]));
const groups = new Set(els(doc, 'ActivationGroup').map((g) => at(g, 'Name')));
const features = new Set();
for (const fg of els(doc, 'FeatureGroup')) for (const f of els(fg, 'Feature')) features.add(`${at(fg, 'Name')}.${at(f, 'Name')}`);
const wheels = new Map(els(doc, 'Wheel').map((w) => [at(w, 'Name'), els(w, 'Slot')]));
const filters = new Set(els(doc, 'Filter').map((f) => at(f, 'Name')));
const emitters = new Set(els(doc, 'Emitter').map((f) => at(f, 'Name')));
const models = new Set(els(doc, 'Model').map((m) => at(m, 'Name')));
const geomTags = ['Geometry', 'Axis', 'Beam', 'FilterBeam', 'FilterColor', 'FilterGobo', 'FilterShaper', 'Laser', 'Display', 'GeometryReference', 'WiringObject', 'Inventory', 'Structure', 'Support', 'Magnet', 'MediaServerLayer', 'MediaServerCamera', 'MediaServerMaster'];
const geometries = new Map();
const geomRoot = els(doc, 'Geometries')[0];
for (const t of geomTags) for (const g of els(geomRoot, t)) geometries.set(at(g, 'Name'), g);

const nameCheck = (where, n) => {
  if (n == null) return;
  if (n !== n.trim()) fault(where, `name "${n}" has leading or trailing space`);
  if (n.includes('.')) fault(where, `name "${n}" contains "." which breaks Node links`);
};

for (const [n, a] of attributes) {
  nameCheck(`Attribute ${n}`, n);
  if (at(a, 'ActivationGroup') && !groups.has(at(a, 'ActivationGroup'))) fault(`Attribute ${n}`, `ActivationGroup ${at(a, 'ActivationGroup')} missing`);
  if (!features.has(at(a, 'Feature'))) fault(`Attribute ${n}`, `Feature ${at(a, 'Feature')} missing`);
  if (at(a, 'MainAttribute') && !attributes.has(at(a, 'MainAttribute'))) fault(`Attribute ${n}`, `MainAttribute ${at(a, 'MainAttribute')} missing`);
}
for (const [n, slots] of wheels) {
  nameCheck(`Wheel ${n}`, n);
  const seen = new Set();
  for (const s of slots) {
    nameCheck(`Wheel ${n} slot`, at(s, 'Name'));
    if (seen.has(at(s, 'Name'))) fault(`Wheel ${n}`, `slot name "${at(s, 'Name')}" repeated`);
    seen.add(at(s, 'Name'));
    const media = at(s, 'MediaFileName');
    if (media && (images || wheelsDir) && !hasImage(media)) fault(`Wheel ${n}`, `wheels/${media}.png missing`);
    if (at(s, 'Filter') && !filters.has(at(s, 'Filter'))) fault(`Wheel ${n}`, `Filter ${at(s, 'Filter')} missing`);
  }
}
for (const g of geometries.values()) {
  nameCheck(`Geometry ${at(g, 'Name')}`, at(g, 'Name'));
  if (at(g, 'Model') && !models.has(at(g, 'Model'))) fault(`Geometry ${at(g, 'Name')}`, `Model ${at(g, 'Model')} missing`);
  if (g.tagName === 'Beam') {
    const b = parseFloat(at(g, 'BeamAngle')); const f = parseFloat(at(g, 'FieldAngle'));
    if (f < b) fault(`Beam ${at(g, 'Name')}`, `FieldAngle ${f} is narrower than BeamAngle ${b}`);
  }
}

const dmx = (v, bytes) => {
  const m = /^(\d+)\/(\d+)(s?)$/.exec(v);
  if (!m) return NaN;
  const [n, k, shift] = [Number(m[1]), Number(m[2]), m[3]];
  if (k === bytes) return n;
  if (shift) return n * 256 ** (bytes - k);
  // byte mirroring: 255/1 in 16 bit = 65535
  let r = n; for (let i = k; i < bytes; i++) r = r * 256 + (n & 255);
  return r;
};

const used = { wheels: new Set(), filters: new Set(), emitters: new Set() };
for (const mode of els(doc, 'DMXMode')) {
  const mname = at(mode, 'Name');
  nameCheck(`DMXMode ${mname}`, mname);
  if (!geometries.has(at(mode, 'Geometry'))) fault(`DMXMode ${mname}`, `Geometry ${at(mode, 'Geometry')} missing`);
  const chNames = new Set(); const offsets = new Map(); const geoAttr = new Map();
  for (const ch of els(mode, 'DMXChannel')) {
    const geo = at(ch, 'Geometry');
    const offs = (at(ch, 'Offset') || 'None') === 'None' ? [] : at(ch, 'Offset').split(',').map(Number);
    const bytes = offs.length || 1;
    const max = 256 ** bytes - 1;
    const lcs = els(ch, 'LogicalChannel');
    const chName = `${geo}_${at(lcs[0], 'Attribute')}`;
    const where = `ch ${offs.join(',')} ${chName}`;
    if (!geometries.has(geo)) fault(where, `Geometry "${geo}" missing`);
    if (chNames.has(chName)) fault(where, 'DMX channel name repeated in the mode');
    chNames.add(chName);
    for (const o of offs) { if (offsets.has(o)) fault(where, `offset ${o} also used by ${offsets.get(o)}`); offsets.set(o, chName); }
    const fnPaths = new Set();
    for (const lc of lcs) {
      const la = at(lc, 'Attribute');
      if (!attributes.has(la)) fault(where, `LogicalChannel Attribute ${la} missing`);
      const fns = els(lc, 'ChannelFunction');
      let prev = -1;
      fns.forEach((fn, i) => {
        const fa = at(fn, 'Attribute');
        const fname = at(fn, 'Name');
        const fwhere = `${where} / ${fname}`;
        nameCheck(fwhere, fname);
        fnPaths.add(`${chName}.${la}.${fname}`);
        if (fa && !attributes.has(fa)) fault(fwhere, `Attribute ${fa} missing`);
        const key = `${geo}|${fa}`;
        if (geoAttr.has(key) && geoAttr.get(key) !== chName) fault(fwhere, `attribute ${fa} on ${geo} is also driven by ${geoAttr.get(key)}`);
        geoAttr.set(key, chName);
        const from = dmx(at(fn, 'DMXFrom') || '0/1', bytes);
        if (from <= prev) fault(fwhere, 'DMXFrom does not rise');
        prev = from;
        const to = i + 1 < fns.length ? dmx(at(fns[i + 1], 'DMXFrom') || '0/1', bytes) - 1 : max;
        const def = at(fn, 'Default') ? dmx(at(fn, 'Default'), bytes) : from;
        if (def < from || def > to) fault(fwhere, `Default ${at(fn, 'Default')} lies outside ${from}..${to}`);
        const wheel = at(fn, 'Wheel');
        if (wheel) { used.wheels.add(wheel); if (!wheels.has(wheel)) fault(fwhere, `Wheel ${wheel} missing`); }
        if (at(fn, 'Filter')) { used.filters.add(at(fn, 'Filter')); if (!filters.has(at(fn, 'Filter'))) fault(fwhere, `Filter ${at(fn, 'Filter')} missing`); }
        if (at(fn, 'Emitter')) { used.emitters.add(at(fn, 'Emitter')); if (!emitters.has(at(fn, 'Emitter'))) fault(fwhere, `Emitter ${at(fn, 'Emitter')} missing`); }
        let sprev = -1; const setNames = new Set();
        for (const cs of els(fn, 'ChannelSet')) {
          const sv = dmx(at(cs, 'DMXFrom') || '0/1', bytes);
          const sn = at(cs, 'Name') || '';
          nameCheck(`${fwhere} set`, sn);
          if (sn && setNames.has(sn)) fault(fwhere, `channel set name "${sn}" repeated`);
          setNames.add(sn);
          if (sv < from || sv > to) fault(fwhere, `set "${sn}" at ${at(cs, 'DMXFrom')} lies outside the function ${from}..${to}`);
          if (sv <= sprev) fault(fwhere, `set "${sn}" does not rise`);
          sprev = sv;
          const idx = at(cs, 'WheelSlotIndex');
          if (wheel) {
            const n = idx == null ? null : Number(idx);
            const slots = wheels.get(wheel) || [];
            if (n == null || n < 1 || n > slots.length) fault(fwhere, `set "${sn}" WheelSlotIndex ${idx} is not a slot of ${wheel} (1..${slots.length})`);
            else if (sn && slots[n - 1] && at(slots[n - 1], 'Name') && !sn.toLowerCase().includes(at(slots[n - 1], 'Name').toLowerCase())) fault(fwhere, `set "${sn}" points at slot ${n} "${at(slots[n - 1], 'Name')}"`);
          }
        }
      });
    }
    const init = at(ch, 'InitialFunction');
    if (init && !fnPaths.has(init)) fault(where, `InitialFunction "${init}" does not resolve`);
    const hl = at(ch, 'Highlight');
    if (hl && hl !== 'None') {
      const v = dmx(hl, bytes);
      if (v > max) fault(where, `Highlight ${hl} beyond the channel`);
    }
  }
}
for (const w of wheels.keys()) if (!used.wheels.has(w)) fault(`Wheel ${w}`, 'no channel function uses it');
for (const f of filters) if (!used.filters.has(f) && !els(doc, 'Slot').some((s) => at(s, 'Filter') === f)) fault(`Filter ${f}`, 'nothing links it');
for (const e of emitters) if (!used.emitters.has(e)) fault(`Emitter ${e}`, 'nothing links it');

console.log(out.length ? out.join('\n') : 'no findings');
console.log(`-- ${out.length} findings`);
