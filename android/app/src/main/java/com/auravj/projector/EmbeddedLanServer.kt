package com.auravj.projector

import android.content.Context
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import kotlin.concurrent.thread

/**
 * Вбудований локальний HTTP + WebSocket сервер для Android-проектора (Zero-Dependency).
 * Дозволяє смартфону (iPhone / Android) підключатися безпосередньо до проектора
 * у спільній Wi-Fi мережі роутера БЕЗ участі ноутбука чи інтернету!
 */
class EmbeddedLanServer(
    private val context: Context,
    private val port: Int = 3456
) {
    private var serverSocket: ServerSocket? = null
    @Volatile private var isRunning = false
    private val threadPool = Executors.newCachedThreadPool()
    private val wsClients = Collections.newSetFromMap(ConcurrentHashMap<Socket, Boolean>())

    fun start() {
        if (isRunning) return
        isRunning = true

        thread(name = "AuraLanServer") {
            try {
                val ss = ServerSocket(port)
                serverSocket = ss
                while (isRunning && !ss.isClosed) {
                    try {
                        val client = ss.accept()
                        threadPool.execute { handleConnection(client) }
                    } catch (e: Exception) {
                        if (!isRunning) break
                    }
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    fun stop() {
        isRunning = false
        try {
            serverSocket?.close()
        } catch (e: Exception) {}
        for (client in wsClients) {
            try { client.close() } catch (e: Exception) {}
        }
        wsClients.clear()
        threadPool.shutdownNow()
    }

    private fun handleConnection(socket: Socket) {
        try {
            val input = socket.getInputStream()
            val output = socket.getOutputStream()

            val requestLines = mutableListOf<String>()
            val headerStream = ByteArrayOutputStream()
            var prev = -1
            var b: Int

            // Читаємо заголовки HTTP (до порожнього рядка \r\n\r\n)
            while (input.read().also { b = it } != -1) {
                headerStream.write(b)
                if (prev == '\r'.code && b == '\n'.code) {
                    val bytes = headerStream.toByteArray()
                    val line = String(bytes, 0, bytes.size - 2, StandardCharsets.UTF_8)
                    headerStream.reset()
                    if (line.isEmpty()) break
                    requestLines.add(line)
                }
                prev = b
            }

            if (requestLines.isEmpty()) {
                socket.close()
                return
            }

            val requestLine = requestLines[0]
            val parts = requestLine.split(" ")
            if (parts.size < 2) {
                socket.close()
                return
            }

            val method = parts[0]
            val path = parts[1].split("?")[0]

            val headers = mutableMapOf<String, String>()
            for (i in 1 until requestLines.size) {
                val colonIdx = requestLines[i].indexOf(":")
                if (colonIdx > 0) {
                    val key = requestLines[i].substring(0, colonIdx).trim().lowercase()
                    val value = requestLines[i].substring(colonIdx + 1).trim()
                    headers[key] = value
                }
            }

            // Перевірка на WebSocket Upgrade
            val isWsUpgrade = headers["upgrade"]?.equals("websocket", ignoreCase = true) == true
            if (isWsUpgrade) {
                val secKey = headers["sec-websocket-key"]
                if (secKey != null) {
                    handleWebSocketHandshake(socket, input, output, secKey)
                    return
                }
            }

            // Звичайний HTTP GET для роздачі сторінки та скриптів
            if (method.equals("GET", ignoreCase = true)) {
                handleHttpRequest(output, path)
            } else {
                sendHttpResponse(output, 405, "Method Not Allowed", "text/plain", "Method not allowed".toByteArray())
            }

            socket.close()
        } catch (e: Exception) {
            try { socket.close() } catch (ex: Exception) {}
        }
    }

    private fun handleHttpRequest(output: OutputStream, rawPath: String) {
        val cleanPath = when {
            rawPath == "/" || rawPath.isEmpty() -> "index.html"
            rawPath.startsWith("/") -> rawPath.substring(1)
            else -> rawPath
        }

        if (cleanPath == "api/info" || cleanPath == "api/version") {
            val json = "{\"version\":\"2.7.0\",\"name\":\"AURA VJ Embedded Android Server\",\"port\":$port}"
            sendHttpResponse(output, 200, "OK", "application/json; charset=utf-8", json.toByteArray(StandardCharsets.UTF_8))
            return
        }

        val mimeType = when {
            cleanPath.endsWith(".html") -> "text/html; charset=utf-8"
            cleanPath.endsWith(".css") -> "text/css; charset=utf-8"
            cleanPath.endsWith(".js") -> "application/javascript; charset=utf-8"
            cleanPath.endsWith(".json") -> "application/json; charset=utf-8"
            cleanPath.endsWith(".svg") -> "image/svg+xml"
            cleanPath.endsWith(".png") -> "image/png"
            cleanPath.endsWith(".apk") -> "application/vnd.android.package-archive"
            else -> "application/octet-stream"
        }

        try {
            val assetStream: InputStream = context.assets.open(cleanPath)
            val bytes = assetStream.readBytes()
            assetStream.close()
            sendHttpResponse(output, 200, "OK", mimeType, bytes)
        } catch (e: Exception) {
            sendHttpResponse(output, 404, "Not Found", "text/plain", "Asset not found: $cleanPath".toByteArray())
        }
    }

    private fun sendHttpResponse(output: OutputStream, code: Int, status: String, contentType: String, data: ByteArray) {
        val header = "HTTP/1.1 $code $status\r\n" +
            "Content-Type: $contentType\r\n" +
            "Content-Length: ${data.size}\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            "Cache-Control: no-cache, no-store, must-revalidate\r\n" +
            "Connection: close\r\n\r\n"

        output.write(header.toByteArray(StandardCharsets.UTF_8))
        output.write(data)
        output.flush()
    }

    private fun handleWebSocketHandshake(socket: Socket, input: InputStream, output: OutputStream, secKey: String) {
        val magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        val md = MessageDigest.getInstance("SHA-1")
        val hash = md.digest((secKey + magic).toByteArray(StandardCharsets.UTF_8))
        val acceptKey = Base64.encodeToString(hash, Base64.NO_WRAP)

        val response = "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: $acceptKey\r\n\r\n"

        output.write(response.toByteArray(StandardCharsets.UTF_8))
        output.flush()

        wsClients.add(socket)
        broadcastPeerCount()

        try {
            while (isRunning && !socket.isClosed) {
                val b1 = input.read()
                if (b1 == -1) break
                val opcode = b1 and 0x0F

                val b2 = input.read()
                if (b2 == -1) break
                val isMasked = (b2 and 0x80) != 0
                var len = (b2 and 0x7F).toLong()

                if (len == 126L) {
                    val b3 = input.read()
                    val b4 = input.read()
                    if (b3 == -1 || b4 == -1) break
                    len = (((b3 and 0xFF) shl 8) or (b4 and 0xFF)).toLong()
                } else if (len == 127L) {
                    val buf = ByteArray(8)
                    if (input.read(buf) != 8) break
                    len = 0L
                    for (i in 0 until 8) {
                        len = (len shl 8) or ((buf[i].toInt() and 0xFF).toLong())
                    }
                }

                val mask = ByteArray(4)
                if (isMasked) {
                    if (input.read(mask) != 4) break
                }

                val payload = ByteArray(len.toInt())
                var totalRead = 0
                while (totalRead < len) {
                    val count = input.read(payload, totalRead, len.toInt() - totalRead)
                    if (count == -1) break
                    totalRead += count
                }

                if (isMasked) {
                    for (i in payload.indices) {
                        payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
                    }
                }

                // Opcode 0x8 = Close
                if (opcode == 0x8) break

                // Opcode 0x9 = Ping -> відповідаємо Pong (0xA)
                if (opcode == 0x9) {
                    sendRawFrame(output, 0xA, payload)
                    continue
                }

                // Opcode 0x1 = Text message (ретранслюємо усім іншим клієнтам)
                if (opcode == 0x1) {
                    broadcastMessage(socket, payload)
                }
            }
        } catch (e: Exception) {
            // Клієнт відключився
        } finally {
            wsClients.remove(socket)
            try { socket.close() } catch (e: Exception) {}
            broadcastPeerCount()
        }
    }

    private fun broadcastMessage(senderSocket: Socket, payload: ByteArray) {
        val frame = buildServerFrame(0x1, payload)
        for (client in wsClients) {
            if (client != senderSocket && !client.isClosed) {
                try {
                    client.getOutputStream().write(frame)
                    client.getOutputStream().flush()
                } catch (e: Exception) {
                    wsClients.remove(client)
                }
            }
        }
    }

    private fun broadcastPeerCount() {
        val countMsg = "{\"type\":\"peers\",\"count\":${wsClients.size}}"
        val frame = buildServerFrame(0x1, countMsg.toByteArray(StandardCharsets.UTF_8))
        for (client in wsClients) {
            if (!client.isClosed) {
                try {
                    client.getOutputStream().write(frame)
                    client.getOutputStream().flush()
                } catch (e: Exception) {}
            }
        }
    }

    private fun buildServerFrame(opcode: Int, payload: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(0x80 or (opcode and 0x0F)) // FIN + opcode

        val len = payload.size
        when {
            len < 126 -> out.write(len)
            len <= 65535 -> {
                out.write(126)
                out.write((len shr 8) and 0xFF)
                out.write(len and 0xFF)
            }
            else -> {
                out.write(127)
                for (i in 7 downTo 0) {
                    out.write((len.toLong() shr (i * 8)).toInt() and 0xFF)
                }
            }
        }
        out.write(payload)
        return out.toByteArray()
    }

    private fun sendRawFrame(output: OutputStream, opcode: Int, payload: ByteArray) {
        val frame = buildServerFrame(opcode, payload)
        output.write(frame)
        output.flush()
    }
}
