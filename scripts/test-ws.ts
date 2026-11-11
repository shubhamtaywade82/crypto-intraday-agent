// Test Binance futures WebSocket connectivity from sandbox
const topics = ['!ticker@arr', 'btcusdt@kline_15m', 'btcusdt@markPrice@1s'];
const url = 'wss://fstream.binance.com/market/stream?streams=' + topics.join('/');
const ws = new WebSocket(url);
let count = 0;
const timer = setTimeout(() => { console.log('TIMEOUT_NO_MESSAGES'); process.exit(1); }, 20000);
ws.onopen = () => console.log('WS_OPEN');
ws.onmessage = (ev) => {
  count++;
  const data = JSON.parse(String(ev.data));
  if (count <= 3) {
    const s = JSON.stringify(data);
    console.log('MSG_' + count + ': ' + s.slice(0, 220));
  }
  if (count >= 5) { clearTimeout(timer); console.log('WS_OK messages=' + count); ws.close(); process.exit(0); }
};
ws.onerror = (e) => { console.log('WS_ERROR: ' + (e as any)?.message); process.exit(1); };
