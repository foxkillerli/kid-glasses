export default {
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== '/echo') return new Response('not found', { status: 404 })
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('websocket echo: connect with Upgrade: websocket', {
        status: 426,
        headers: { 'Access-Control-Allow-Origin': '*' },
      })
    }
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    server.accept()
    server.send('kid-glasses echo ready')
    server.addEventListener('message', event => {
      try {
        server.send(event.data)
      } catch {
        server.close(1011, 'send failed')
      }
    })
    server.addEventListener('close', event => {
      try {
        server.close(1000, 'bye')
      } catch {
        return
      }
    })
    return new Response(null, { status: 101, webSocket: client })
  },
}
