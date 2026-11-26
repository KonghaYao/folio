async ([n, iterations]) => {
  const { createBoardCanvas } = await import('/client/canvas/index.ts');
  const canvas = createBoardCanvas(document.querySelector('#surface'), { boardId: 'scale' }),
    { store, editor } = canvas;
  editor.setCamera({ x: 0, y: 0, z: 1 });
  const records = {};
  const columns = Math.ceil(Math.sqrt(n)),
    spacing = 100,
    ink = {
      size: 's',
      color: 'black',
      isPen: false,
      done: true,
      pts: [0, 0, 0.5, 4, 6, 0.5, 8, 7, 0.5, 14, 9, 0.6, 22, 15, 0.5, 32, 18, 0.6],
    };
  for (let i = 0; i < n; i++) {
    const id = 'shape:' + i,
      x = (i % columns) * spacing + 8,
      y = Math.floor(i / columns) * spacing + 8;
    const type = i % 5 === 1 ? 'draw' : i % 17 === 3 ? 'highlight' : 'geo';
    records[id] = {
      id,
      typeName: 'shape',
      type,
      x,
      y,
      rot: 0,
      z: i,
      props:
        type === 'geo'
          ? {
              geo: i % 3 ? 'rectangle' : 'ellipse',
              size: 's',
              color: 'green',
              fill: 'solid',
              dash: 'solid',
              w: 40,
              h: 30,
            }
          : ink,
    };
  }
  const start = performance.now();
  store.loadSnapshot({ document: { store: records } });
  const loadMs = performance.now() - start;
  const target = document.createElement('canvas');
  target.width = 800;
  target.height = 600;
  const ctx = target.getContext('2d');
  const render = (z = 1, j = 0) =>
    editor.renderScene(ctx, { x: -(j % 7), y: -(j % 3), z }, 800, 600, { background: false });
  const t = performance.now();
  render();
  const firstRenderMs = performance.now() - t;
  // Allow normal rAF, font readiness and bounded background index work before steady-state samples.
  // Exercise updates while a large replacement may still be indexing.
  await new Promise((resolve) => setTimeout(resolve, 35));
  store.update('shape:0', { x: -140, y: -150 }, 'remote');
  if (editor.hitTest(-120, -135)?.id !== 'shape:0') throw Error('Cold edit was lost');
  await new Promise((resolve) => setTimeout(resolve, 615));
  if (editor.hitTest(-120, -135)?.id !== 'shape:0' || editor.hitTest(28, 23) !== null)
    throw Error('Stale record after initial index construction');
  store.put(records['shape:0'], 'remote');
  function bench(fn, batch = 1) {
    const values = [];
    for (let i = -5; i < iterations; i++) {
      const t = performance.now();
      for (let j = 0; j < batch; j++) fn(Math.abs(i) * batch + j);
      if (i >= 0) values.push((performance.now() - t) / batch);
    }
    values.sort((a, b) => a - b);
    const q = (p) => Number(values[Math.ceil(p * values.length) - 1].toFixed(3));
    return { p50: q(0.5), p95: q(0.95) };
  }
  function view(zoom) {
    const visible = Object.values(records).filter(
      (s) => s.x < 800 / zoom && s.y < 600 / zoom,
    ).length;
    return { zoom, visibleApprox: visible, render: bench((j) => render(zoom, j)) };
  }
  const result = {
    objects: n,
    loadMs,
    firstRenderMs,
    sparse: view(1),
    dense: view(0.14),
    miss: bench((j) => {
      if (editor.hitTest(83 + (j % 4), 83) !== null) throw Error('Unexpected hit');
    }, 10),
    hit: bench(() => {
      if (editor.hitTest(28, 23)?.id !== 'shape:0') throw Error('Incorrect hit');
    }, 10),
    moveAndRender: bench((j) => {
      store.update('shape:0', { x: 8 + (j % 24) });
      render(1, j);
    }),
    moveZ: bench(() => store.maxZ(), 40),
  };
  store.update('shape:0', { x: 35002, y: 35002 });
  if (editor.hitTest(28, 23) !== null || editor.hitTest(35022, 35017)?.id !== 'shape:0')
    throw Error('Stale placement');
  store.undo();
  if (!editor.hitTest(store.get('shape:0').x + 20, 23)) throw Error('Undo failed');
  store.put(records['shape:0'], 'remote');
  async function fingerprint(zoom) {
    render(zoom);
    const data = ctx.getImageData(0, 0, 800, 600).data;
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  result.rgbaSHA256 = { sparse: await fingerprint(1), dense: await fingerprint(0.14) };
  canvas.destroy();
  return result;
};
