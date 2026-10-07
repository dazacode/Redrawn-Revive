// DEV ONLY: tiny static server for previewing public/ without the backend.
//   bun public/dev/serve.ts [port]      then open http://localhost:5173/?mock
// Mirrors the routes the real server must provide: /cc, /cc_browser, /go_full, /player -> editor.html
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const port = Number(process.argv[2] ?? 5173);
const editorRoutes = new Set(['/cc', '/cc_browser', '/go_full', '/player']);
Bun.serve({
  port,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    let p = editorRoutes.has(pathname) ? '/editor.html' : pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
    if (p.includes('..')) return new Response('Bad path', { status: 400 });
    const f = Bun.file(root + p);
    return (await f.exists()) ? new Response(f) : new Response('Not found', { status: 404 });
  },
});
console.log(`Redrawn UI preview on http://localhost:${port}/?mock`);
