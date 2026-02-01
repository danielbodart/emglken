// Simple HTTP server for JSPI testing
const server = Bun.serve({
  port: 8080,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname;
    if (path === '/') path = '/index.html';

    const file = Bun.file('./examples/jspi-browser' + path);
    if (await file.exists()) {
      return new Response(file);
    }
    return new Response('Not found', { status: 404 });
  },
});

console.log(`Server running at http://localhost:${server.port}`);
