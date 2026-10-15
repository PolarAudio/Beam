// Loads GDTF files into the running Beam as in-memory types (nothing written
// to the library), builds a blank scene and hangs one head per file in a row,
// 3 m apart, 5 m up, pointing down. Run after tools/dev/regress/prelude.js.
//
// window.__args = { files: ['tools/dev/out/x/a.gdtf', ...] }  (paths under the repo:
// Vite serves them through /@fs/)
// Returns each file's reader problems and the first head's channel names,
// which shot.js takes as keys.
(async () => {
  const bt = window.__bt;
  const { show } = bt;
  const live = window.__live;
  const reader = await import(live('/src/models/DMX/gdtf/gdtf_reader.js'));
  const body = await import(live('/src/plugins/visualizer/gdtf_body.js'));
  const parseXml = (t) => new DOMParser().parseFromString(t, 'text/xml');
  const { files } = window.__args;
  await bt.reset();
  const out = { files: [] };
  const heads = {};
  for (let i = 0; i < files.length; i += 1) {
    const name = `t${i}`;
    const key = `GdtfTest/${name}`;
    const res = await fetch(`/@fs/D:/Projects/beatline/Beam/${files[i]}`);
    if (!res.ok) throw new Error(`${files[i]}: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const { fixtureType, files: parts, problems } = reader.default(bytes, { parseXml });
    const urlOf = (image) => URL.createObjectURL(new Blob([image.bytes], { type: image.mime }));
    fixtureType.wheelImages = new Map([...reader.wheelImages(fixtureType, parts)].map(([k, im]) => [k, urlOf(im)]));
    fixtureType.body = await body.default(fixtureType, parts);
    show.gdtfTypes.set(key, fixtureType);
    if (!show.gdtfFixtures.find((e) => e.key === key)) {
      show.gdtfFixtures.push({ key, manufacturer: 'GdtfTest', fixture: name, file: `${name}.gdtf` });
    }
    const x = (i - (files.length - 1) / 2) * 3;
    heads[name] = await bt.place('GdtfTest', name, { x, y: 0, z: 5 }, { x: 180, y: 0, z: 0 });
    out.files.push({ file: files[i], problems, address: heads[name].address });
  }
  window.__heads = heads;
  out.channels = Object.values(heads)[0].channels.map((c) => c.name || c);
  return JSON.stringify(out);
})()
