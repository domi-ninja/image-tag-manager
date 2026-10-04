// Optional native WebDriver check. Requires tauri-driver on port 4444.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const base = 'http://127.0.0.1:4444';
async function request(method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const j = await r.json();
  if (!r.ok || j.value?.error) throw new Error(JSON.stringify(j));
  return j.value;
}
const session = await request('POST', '/session', {
  capabilities: {
    alwaysMatch: {
      'tauri:options': { application: resolve('.test-tools/package/usr/bin/image-shelf') },
    },
  },
});
const id = session.sessionId;
console.log('Native session', id);
const execute = (script) => request('POST', `/session/${id}/execute/sync`, { script, args: [] });
const invoke = (command, args = {}) =>
  request('POST', `/session/${id}/execute/async`, {
    script:
      'const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(v=>done({ok:true,value:v}),e=>done({ok:false,error:String(e)}));',
    args: [command, args],
  }).then((r) => {
    if (!r.ok) throw new Error(r.error);
    return r.value;
  });
try {
  await request('POST', `/session/${id}/timeouts`, { script: 120000 });
  let loaded = false;
  for (let i = 0; i < 20; i++) {
    const body = await execute('return document.body.innerText');
    if (body.includes('Image Shelf')) {
      loaded = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!loaded) throw new Error('Native UI did not load');
  const before = await invoke('stats');
  console.log('Native SQLite stats', before);
  if (before.classified < 3) throw new Error('Expected actual native inference records');
  const folders = await invoke('folders');
  const folder = folders[0];
  await invoke('save_folder', {
    folder: { ...folder, categories: ['landscape', 'vehicle', 'portrait', 'flowers', 'building'] },
  });
  await invoke('start', { action: 'classify' });
  let processed = false;
  for (let i = 0; i < 120; i++) {
    const status = await invoke('status');
    if (status.phase === 'error') throw new Error(status.message);
    if (status.processed >= 1) {
      await invoke('pause');
      processed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!processed) throw new Error('Native classification did not complete in 120 seconds');
  for (let i = 0; i < 120; i++) {
    const s = await invoke('status');
    if (!s.busy) break;
    if (i === 119) throw new Error('Pause did not finish');
    await new Promise((r) => setTimeout(r, 1000));
  }
  const after = await invoke('stats');
  if (after.classified <= before.classified) throw new Error('Classification did not reach SQLite');
  const results = await invoke('search', {
    filter: { query: 'mountain', folderId: null, tag: null, status: null, page: 0 },
  });
  if (results.total < 1) throw new Error('Native FTS returned no matching image');
  await execute(
    `const input=document.querySelector('input[aria-label="Search images"]');const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'mountain');input.dispatchEvent(new Event('input',{bubbles:true}));`,
  );
  await new Promise((r) => setTimeout(r, 1800));
  const png = await request('GET', `/session/${id}/screenshot`);
  await writeFile('results/desktop-native.png', Buffer.from(png, 'base64'));
  const report = {
    before,
    after,
    search: { query: 'mountain', total: results.total },
    status: await invoke('status'),
    platform: 'Linux native WebKit, extracted Debian package',
    runtime: 'Bundled llama.cpp, Qwen3-VL-2B Q8_0, 8 CPU threads',
    classificationMode: 'Live native inference with configured category enum',
  };
  await writeFile('results/desktop-validation.json', JSON.stringify(report, null, 2) + '\n');
  console.log(report);
} finally {
  await request('DELETE', `/session/${id}/window`).catch(() => undefined);
  await request('DELETE', `/session/${id}`).catch(() => undefined);
}
