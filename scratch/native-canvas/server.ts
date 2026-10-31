// Optional isolated transport/telemetry probe. bun scratch/native-canvas/server.ts
const records: unknown[] = [];
const clients = new Set<any>();
const server = Bun.serve({ hostname:'127.0.0.1', port: 18743,
 async fetch(req,server) {
  const u=new URL(req.url);
  if(u.pathname==='/ws' && server.upgrade(req)) return;
  if(req.method==='POST') { const data=await req.json();records.push({received:Date.now(),...data});if(u.pathname==='/scene') for(const c of clients)c.send(JSON.stringify(data));return Response.json({ok:true}); }
  return Response.json(records);
 },
 websocket:{open(ws){clients.add(ws)},message(ws,message){ws.send(message)},close(ws){clients.delete(ws)}}
});
console.log(`native-canvas probe ${server.url}`);
