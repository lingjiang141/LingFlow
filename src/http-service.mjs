import http from "node:http";

/** Stop HTTP ingress without abandoning work already accepted by the handler. */
export function createHttpService(handler, { shutdownGraceMs = 1000 } = {}) {
  const sockets = new Set();
  const pending = new Set();
  let closing;
  const server = http.createServer((req, res) => {
    if (closing) {
      res.writeHead(503, { "Connection": "close", "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "LingFlow 正在退出，请稍后重新连接" }));
      return;
    }
    const work = Promise.resolve().then(() => handler(req, res));
    pending.add(work);
    void work.catch(error => res.destroy(error)).finally(() => pending.delete(work));
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return {
    server,
    close() {
      return closing ??= (async () => {
        const drained = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        // Includes incomplete uploads and upgraded sockets. Closing transport
        // does not cancel a handler or terminate a workflow/SQLite worker.
        const timer = setTimeout(() => {
          for (const socket of sockets) socket.destroy();
        }, shutdownGraceMs);
        try {
          await drained;
          await Promise.allSettled([...pending]);
        } finally { clearTimeout(timer); }
      })();
    },
  };
}
