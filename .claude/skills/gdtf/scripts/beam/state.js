// What the engine reads on each test head for channels whose attribute
// matches window.__stateMatch (a regex source, default everything): value,
// active function, set, wheel slot and physical value.
(() => {
  const match = new RegExp(window.__stateMatch || '.');
  const out = {};
  Object.entries(window.__heads).forEach(([n, f]) => {
    out[n] = f._engine.channels
      .filter((c) => c.state && c.state.fn && match.test(c.state.fn.attribute))
      .map((c) => {
        const s = c.state;
        return `${s.fn.attribute} v=${c.value} fn="${s.fn.name}" set="${s.set ? s.set.name : ''}" `
          + `slot=${s.set ? s.set.wheelSlotIndex : '-'} phys=${s.physical}`;
      });
  });
  return JSON.stringify(out, null, 1);
})()
