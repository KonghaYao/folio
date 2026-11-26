// esbuild resolves @folio to the source checkout selected by run.py.
import { createBoardCanvas } from '@folio/canvas';
import { createCanvasMcp } from '@folio/canvas-mcp';

export async function run(count: number) {
  const host = document.body.appendChild(document.createElement('div'));
  Object.assign(host.style, { width: '1200px', height: '800px' });
  const canvas = createBoardCanvas(host, { boardId: 'benchmark' });
  const { store, editor } = canvas;
  const key = (i: number) => 'shape-' + String(i).padStart(6, '0');
  const record = (i: number) => ({
    id: key(i),
    typeName: 'shape',
    type: 'geo',
    x: (i % 250) * 180,
    y: Math.floor(i / 250) * 110,
    rot: i % 9 === 0 ? 0.17 : 0,
    z: (i * 7919) % 4096,
    props: {
      geo: 'rectangle',
      w: 90,
      h: 55,
      font: 'sans',
      size: 'm',
      dash: 'solid',
      fill: 'none',
      color: 'black',
      label: i % 8 === 0 ? 'Atlas project' : 'River project',
    },
  });
  store.transact(() => {
    for (let i = 0; i < count; i++) store.put(record(i), 'remote');
  }, 'remote');
  editor.setSelection([key(123), key(250), key(count - 1)]);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const bridge = await createCanvasMcp({ boardId: 'benchmark', canvas, async flush() {} });
  let sequence = 0;
  async function exchange(method: string, params: unknown) {
    return bridge.exchange({ jsonrpc: '2.0', id: ++sequence, method, params });
  }
  await exchange('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'benchmark', version: '1' },
  });
  await bridge.exchange({ jsonrpc: '2.0', method: 'notifications/initialized' });
  async function call(name: string, args: object) {
    const response = await exchange('tools/call', { name, arguments: args });
    if (response.error || response.result.isError) throw new Error(JSON.stringify(response));
    return JSON.parse(response.result.content[0].text);
  }
  const metrics: Record<string, { samples: number; p50Ms: number; p95Ms: number }> = {};
  async function measure(
    name: string,
    action: (iteration: number) => Promise<void>,
    n = 50,
    prepare?: (iteration: number) => void,
  ) {
    const times = [];
    for (let i = -4; i < n; i++) {
      prepare?.(i);
      const t = performance.now();
      await action(i);
      if (i >= 0) times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    metrics[name] = {
      samples: n,
      p50Ms: times[Math.ceil(n * 0.5) - 1],
      p95Ms: times[Math.ceil(n * 0.95) - 1],
    };
  }
  const check = (ok: unknown, label: string) => {
    if (!ok) throw Error(label);
  };
  const startVisible = performance.now();
  await call('canvas_read', { scope: 'visible' });
  const firstVisibleAfterOpenMs = performance.now() - startVisible;
  // Let the interactive canvas run its background jobs before measuring steady-state operations.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await measure('byId', async () => {
    const r = await call('canvas_read', { ids: [key(count - 1)] });
    check(r.matched === 1 && r.objects[0].id === key(count - 1), 'target lookup');
  });
  await measure('selection', async () => {
    const r = await call('canvas_read', { scope: 'selection' });
    check(r.matched === 3, 'selection count');
  });
  await measure('visible', async () => {
    const r = await call('canvas_read', { scope: 'visible' });
    check(r.matched > 0 && r.matched < 150, 'viewport');
  });
  await measure(
    'pannedVisible',
    async () => {
      const r = await call('canvas_read', { scope: 'visible', limit: 25 });
      check(r.matched > 0 && r.matched < 150, 'panned viewport');
    },
    25,
    (i) => editor.setCamera({ x: -Math.abs(i + 5) * 120, y: -300, z: 1 }),
  );
  editor.setCamera({ x: 0, y: 0, z: 0.05 });
  let denseVisible = 0;
  await measure(
    'denseVisiblePages',
    async (i) => {
      const r = await call('canvas_read', { scope: 'visible', offset: (i + 4) * 83, limit: 25 });
      denseVisible = r.matched;
      check(
        r.matched > 8000 && r.matched < count && r.objects.length === 25,
        'zoomed-out viewport',
      );
    },
    25,
  );
  editor.setCamera({ x: 0, y: 0, z: 1 });
  const sortedIds = Array.from({ length: count }, (_, i) => i).sort(
    (a, b) => ((a * 7919) % 4096) - ((b * 7919) % 4096) || a - b,
  );
  await measure('allPages', async (i) => {
    const offset = ((i + 4) * 939) % (count - 25);
    const r = await call('canvas_read', { offset, limit: 25 });
    check(r.matched === count && r.objects[0].id === key(sortedIds[offset]), 'page order');
  });
  const matches = sortedIds.filter((i) => i % 8 === 0);
  await measure('searchPages', async (i) => {
    const offset = ((i + 4) * 113) % (matches.length - 25);
    const r = await call('canvas_read', { query: 'ATLAS', offset, limit: 25 });
    check(r.matched === matches.length && r.objects[0].id === key(matches[offset]), 'search order');
  });
  await measure(
    'allAfterMove',
    async (i) => {
      const r = await call('canvas_read', { limit: 25 });
      check(r.objects[0].id === key(0) && r.objects[0].x === i, 'moved page contents');
    },
    25,
    (i) => store.update(key(0), { x: i }, 'remote'),
  );
  await measure(
    'firstPageAfterInsert',
    async () => {
      const r = await call('canvas_read', { limit: 25 });
      check(r.matched === count + 1 && r.objects[0].id === key(0), 'cold page');
    },
    25,
    (i) =>
      store.transact(() => {
        const even = i % 2 === 0;
        store.remove([even ? 'mcp-extra-b' : 'mcp-extra-a'], 'remote');
        store.put(
          { ...record(count), id: even ? 'mcp-extra-a' : 'mcp-extra-b', z: 9000 },
          'remote',
        );
      }, 'remote'),
  );
  const changes = Array.from({ length: 64 }, (_, i) => ({ id: key(i * 13), x: 100 + i }));
  await measure(
    'update64',
    async (i) => {
      const r = await call('canvas_update', {
        changes: changes.map((c) => ({ ...c, x: c.x + i })),
      });
      check(r.updated.length === 64 && store.get(changes[0].id).x === 100 + i, 'update');
    },
    15,
  );
  const objects = Array.from({ length: 64 }, (_, i) => ({
    kind: 'rectangle',
    x: 20000 + i,
    y: 20000,
    w: 50,
    h: 30,
  }));
  await measure(
    'create64',
    async () => {
      const r = await call('canvas_create', { objects });
      check(r.created.length === 64 && store.has(r.created[63].id), 'create');
    },
    15,
  );
  await bridge.close();
  canvas.destroy();
  host.remove();
  return {
    count,
    firstVisibleAfterOpenMs,
    denseVisible,
    viewport: { width: 1200, height: 800 },
    metrics,
  };
}
