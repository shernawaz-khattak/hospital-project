// Server-Sent Events hub. Used to push notifications and to refresh shared views in real
// time — e.g. bed status must "update in real time across all staff views" (UC-19).
const clients = new Map(); // id -> { res, userId, permissions:Set }
let nextId = 1;

export function addClient(res, { userId, permissions }) {
  const id = nextId++;
  clients.set(id, { res, userId, permissions: new Set(permissions) });
  return () => clients.delete(id);
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
}

export function publishToUser(userId, event, data) {
  for (const c of clients.values()) if (c.userId === userId) send(c.res, event, data);
}

/** Notify every connected user holding any of the given permissions. */
export function publishToPermission(perms, event, data) {
  const list = Array.isArray(perms) ? perms : [perms];
  for (const c of clients.values()) if (list.some((p) => c.permissions.has(p))) send(c.res, event, data);
}

export function broadcast(event, data) {
  for (const c of clients.values()) send(c.res, event, data);
}

export function closeUserStreams(userId) {
  for (const [id, c] of clients) {
    if (c.userId === userId) {
      send(c.res, 'session-ended', {});
      c.res.end();
      clients.delete(id);
    }
  }
}

export const connectedClientCount = () => clients.size;
