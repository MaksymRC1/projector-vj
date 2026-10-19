/**
 * Локальний HTTP + WebSocket сервер без зовнішніх залежностей (Zero-Dependency)
 * Забезпечує миттєву синхронізацію між Смартфоном та Проектором/Smart TV у Wi-Fi мережі.
 * Запуск: node server.js
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const PORT = process.env.PORT || 3456;
const HTTPS_PORT = process.env.HTTPS_PORT || 3457;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".apk": "application/vnd.android.package-archive",
};

const clients = new Set();

function handleHttpRequest(req, res) {
  const urlPath = req.url.split("?")[0];

  // API endpoint для перевірки статусу та версії сервера
  if (urlPath === "/api/info" || urlPath === "/api/version") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
    });
    res.end(JSON.stringify({
      version: "2.7.0",
      ip: getLocalIp(),
      httpPort: PORT,
      httpsPort: HTTPS_PORT,
      timestamp: Date.now(),
    }));
    return;
  }

  const safePath = path.normalize(urlPath === "/" ? "/index.html" : urlPath);
  const filePath = path.join(__dirname, safePath);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
    res.end(content);
  });
}

const server = http.createServer(handleHttpRequest);

// Легка реалізація RFC 6455 WebSocket поверх чистого Node.js net.Socket
function encodeWsFrame(str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeWsFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const byte1 = buffer[offset];
    const byte2 = buffer[offset + 1];
    const opcode = byte1 & 0x0f;
    const isMasked = (byte2 & 0x80) !== 0;
    let payloadLen = byte2 & 0x7f;
    let headerLen = 2;

    if (opcode === 0x8) {
      return { close: true, messages, consumed: buffer.length };
    }

    if (payloadLen === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (offset + 10 > buffer.length) break;
      payloadLen = Number(buffer.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }

    const maskLen = isMasked ? 4 : 0;
    if (offset + headerLen + maskLen + payloadLen > buffer.length) break;

    const payloadStart = offset + headerLen + maskLen;
    const payload = Buffer.alloc(payloadLen);

    if (isMasked) {
      const mask = buffer.subarray(offset + headerLen, payloadStart);
      for (let i = 0; i < payloadLen; i++) {
        payload[i] = buffer[payloadStart + i] ^ mask[i % 4];
      }
    } else {
      buffer.copy(payload, 0, payloadStart, payloadStart + payloadLen);
    }

    if (opcode === 0x1) {
      messages.push(payload.toString("utf8"));
    }
    offset = payloadStart + payloadLen;
  }

  return { close: false, messages, consumed: offset };
}

function handleWsUpgrade(req, socket) {
  if (req.headers["upgrade"] !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request");
    return;
  }

  const key = req.headers["sec-websocket-key"];
  const acceptKey = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11", "binary")
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "\r\n",
    ].join("\r\n")
  );

  clients.add(socket);
  let rxBuffer = Buffer.alloc(0);

  const broadcastPeers = () => {
    const frame = encodeWsFrame(JSON.stringify({ type: "peers", count: clients.size }));
    for (const c of clients) {
      if (!c.destroyed) c.write(frame);
    }
  };
  broadcastPeers();

  socket.on("data", (chunk) => {
    rxBuffer = Buffer.concat([rxBuffer, chunk]);
    const { close, messages, consumed } = decodeWsFrames(rxBuffer);
    rxBuffer = rxBuffer.subarray(consumed);

    if (close) {
      clients.delete(socket);
      socket.end();
      broadcastPeers();
      return;
    }

    for (const msg of messages) {
      const outFrame = encodeWsFrame(msg);
      for (const client of clients) {
        if (client !== socket && !client.destroyed) {
          client.write(outFrame);
        }
      }
    }
  });

  const cleanup = () => {
    clients.delete(socket);
    broadcastPeers();
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
}

server.on("upgrade", handleWsUpgrade);

// Ініціалізація HTTPS сервера для iPhone Safari Secure Context (мікрофон на смартфоні)
let httpsServer = null;
const keyPath = path.join(__dirname, "cert", "key.pem");
const certPath = path.join(__dirname, "cert", "cert.pem");

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  try {
    const httpsOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    };
    httpsServer = https.createServer(httpsOptions, handleHttpRequest);
    httpsServer.on("upgrade", handleWsUpgrade);
  } catch (err) {
    console.warn("⚠️ Помилка створення HTTPS сервера:", err.message);
  }
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "localhost";
}

if (require.main === module) {
  const ip = getLocalIp();

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🚀 AURA VJ LAN Server запущено!`);
    console.log(`📽️ Екран Проектора / Smart TV (HTTP):  http://${ip}:${PORT}/?view=projector`);
    console.log(`🎛️ VJ Студія на комп'ютері:           http://${ip}:${PORT}/?view=split`);

    if (httpsServer) {
      httpsServer.listen(HTTPS_PORT, "0.0.0.0", () => {
        console.log(`📱 Пульт Смартфона (HTTPS Мікрофон):  https://${ip}:${HTTPS_PORT}/?view=remote`);
        console.log(`⚡ Миттєва передача аудіо/ритму по Wi-Fi з iPhone & Android (< 1ms)\n`);
      });
    } else {
      console.log(`📱 Пульт Смартфона (HTTP):            http://${ip}:${PORT}/?view=remote\n`);
    }
  });
}

module.exports = { server, httpsServer };
