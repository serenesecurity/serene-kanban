export function createSSEManager() {
  const clients = new Map();
  let nextId = 0;

  return {
    addClient(res) {
      const id = nextId++;
      clients.set(id, res);
      return id;
    },
    removeClient(id) {
      clients.delete(id);
    },
    broadcast(event, data) {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const [id, res] of clients) {
        try {
          res.write(payload);
        } catch {
          clients.delete(id);
        }
      }
    },
  };
}
