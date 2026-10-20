package com.auravj.projector

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.media.audiofx.Visualizer
import android.net.Uri
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread
import kotlin.math.hypot
import kotlin.math.min

/**
 * Нативний контейнер AURA VJ для Android-проекторів та Smart TV.
 *
 * 1. Live Web/LAN Loader: динамічно завантажує актуальний веб-інтерфейс із локального
 *    сервера комп'ютера або GitHub, тому зміни в шейдерах та синхронізації працюють
 *    МИТТЄВО БЕЗ ПЕРЕВСТАНОВКИ ДОДАТКА!
 * 2. Self-Updater: вміє самостійно завантажувати та оновлювати APK без флешки.
 * 3. Нативний аудіомікшер: захоплення звуку через Visualizer(0).
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var visualizer: Visualizer? = null
    private val AUDIO_PERMISSION_REQ = 1001

    private var embeddedServer: EmbeddedLanServer? = null
    private lateinit var prefs: SharedPreferences
    private val PREF_KEY_SERVER_HOST = "server_host"
    private val DEFAULT_SERVER_HOST = "192.168.0.40:3456"

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        prefs = getSharedPreferences("aura_vj_prefs", Context.MODE_PRIVATE)

        // Запускаємо автономний локальний сервер на проекторі (HTTP: 3456, HTTPS: 3457)
        embeddedServer = EmbeddedLanServer(this, 3456, 3457)
        embeddedServer?.start()

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemUI()

        webView = WebView(this)
        setContentView(webView)

        val settings: WebSettings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.cacheMode = WebSettings.LOAD_NO_CACHE

        // LAYER_TYPE_NONE дозволяє апаратному композитору Android виводити WebGL напряму без проміжного FBO-текстурування на Mali-G31
        webView.setLayerType(View.LAYER_TYPE_NONE, null)
        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedError(
                view: WebView?,
                errorCode: Int,
                description: String?,
                failingUrl: String?
            ) {
                // Якщо зовнішній сервер недоступний — відкриваємо власний вбудований сервер проектора
                val myIp = getLocalIpAddress()
                if (failingUrl?.contains("localhost:3456") == true) {
                    // Якщо локальний сокет ще ініціалізується, відчиняємо локальні ассети напряму
                    view?.loadUrl("file:///android_asset/index.html?view=projector&lan=$myIp:3456")
                } else {
                    view?.loadUrl("http://localhost:3456/?view=projector&lan=$myIp:3456")
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                request.grant(request.resources)
            }
        }

        webView.addJavascriptInterface(AndroidAudioBridge(), "AndroidAudioBridge")

        loadBestAvailableSource()
        checkAndStartSystemAudio()
        checkForUpdatesOnStartup()
    }

    private fun getServerHost(): String {
        return prefs.getString(PREF_KEY_SERVER_HOST, DEFAULT_SERVER_HOST) ?: DEFAULT_SERVER_HOST
    }

    private fun setServerHost(host: String) {
        val clean = host.trim().replace("http://", "").replace("https://", "").replace("/", "")
        prefs.edit().putString(PREF_KEY_SERVER_HOST, clean).apply()
    }

    /**
     * Автоматичне визначення джерела:
     * 1. Якщо запущено сервер на ноутбуці — підключаємось до нього.
     * 2. Якщо ноутбука немає — працює власний автономний сервер проектора (телефон підключається прямо до проектора!).
     */
    private fun loadBestAvailableSource() {
        val host = getServerHost()
        val myIp = getLocalIpAddress()
        thread {
            val isCustomServer = host != DEFAULT_SERVER_HOST && host != "$myIp:3456" && host != "localhost:3456"
            val isLaptopReachable = if (isCustomServer) checkUrlReachable("http://$host/") else checkUrlReachable("http://$DEFAULT_SERVER_HOST/")

            runOnUiThread {
                if (isLaptopReachable) {
                    val activeHost = if (isCustomServer) host else DEFAULT_SERVER_HOST
                    Toast.makeText(this, "⚡ Підключено до комп'ютера: $activeHost", Toast.LENGTH_SHORT).show()
                    webView.loadUrl("http://$activeHost/?view=projector")
                } else {
                    Toast.makeText(this, "📽️ Сервер проектора активний: $myIp:3456", Toast.LENGTH_LONG).show()
                    webView.loadUrl("http://localhost:3456/?view=projector&lan=$myIp:3456")
                }
            }
        }
    }

    private fun getLocalIpAddress(): String {
        try {
            val interfaces = java.net.NetworkInterface.getNetworkInterfaces()
            while (interfaces.hasMoreElements()) {
                val iface = interfaces.nextElement()
                val addresses = iface.inetAddresses
                while (addresses.hasMoreElements()) {
                    val addr = addresses.nextElement()
                    if (!addr.isLoopbackAddress && addr is java.net.Inet4Address) {
                        val hostAddr = addr.hostAddress ?: ""
                        if (hostAddr.isNotEmpty()) return hostAddr
                    }
                }
            }
        } catch (e: Exception) {}
        return "127.0.0.1"
    }

    private fun checkUrlReachable(targetUrl: String): Boolean {
        return try {
            val conn = URL(targetUrl).openConnection() as HttpURLConnection
            conn.connectTimeout = 1200
            conn.readTimeout = 1200
            conn.requestMethod = "HEAD"
            val code = conn.responseCode
            conn.disconnect()
            code in 200..399
        } catch (e: Exception) {
            false
        }
    }

    inner class AndroidAudioBridge {
        @JavascriptInterface
        fun startSystemAudio() {
            runOnUiThread { checkAndStartSystemAudio() }
        }

        @JavascriptInterface
        fun getServerHost(): String = this@MainActivity.getServerHost()

        @JavascriptInterface
        fun setServerHost(host: String) {
            runOnUiThread {
                this@MainActivity.setServerHost(host)
                loadBestAvailableSource()
            }
        }

        @JavascriptInterface
        fun reloadApp() {
            runOnUiThread { loadBestAvailableSource() }
        }

        @JavascriptInterface
        fun updateApk() {
            runOnUiThread { downloadAndInstallApkUpdate() }
        }

        @JavascriptInterface
        fun dismissApkUpdate(releaseId: String) {
            prefs.edit().putString("last_known_release_id", releaseId).apply()
        }

        @JavascriptInterface
        fun getProjectorIp(): String = this@MainActivity.getLocalIpAddress()

        @JavascriptInterface
        fun getAppVersion(): String = "2.7.0"
    }

    /**
     * Автоматична перевірка наявності свіжих релізів на GitHub при старті додатка
     */
    private fun checkForUpdatesOnStartup() {
        thread(name = "AuraApkUpdateChecker") {
            try {
                Thread.sleep(6000) // Чекаємо 6с після запуску, щоб не заважати старту WebGL
                val apiUrl = "https://api.github.com/repos/MaksymRC1/projector-vj/releases/latest"
                val url = URL(apiUrl)
                val conn = url.openConnection() as HttpURLConnection
                conn.connectTimeout = 8000
                conn.readTimeout = 8000
                conn.setRequestProperty("User-Agent", "AuraVJ-Projector/2.7")
                if (conn.responseCode in 200..299) {
                    val body = conn.inputStream.bufferedReader().readText()
                    val idMatch = Regex("\"id\":\\s*(\\d+)").find(body)
                    val currentReleaseId = idMatch?.groupValues?.get(1) ?: ""
                    val lastAcknowledgedId = prefs.getString("last_known_release_id", "")

                    if (currentReleaseId.isNotEmpty() && currentReleaseId != lastAcknowledgedId && body.contains("aura-vj-projector.apk")) {
                        runOnUiThread {
                            // Сповіщаємо веб-інтерфейс та показуємо ненав'язливу підказку
                            webView.evaluateJavascript("window.onApkUpdateAvailable && window.onApkUpdateAvailable('$currentReleaseId');", null)
                        }
                    }
                }
                conn.disconnect()
            } catch (e: Exception) {
                // Відсутність інтернету або помилка GitHub API не заважає локальній роботі
            }
        }
    }

    /**
     * Оновлення APK безпосередньо всередині додатка без комп'ютера чи флешки
     */
    private fun downloadAndInstallApkUpdate() {
        Toast.makeText(this, "⬇️ Завантаження оновлення AURA VJ...", Toast.LENGTH_LONG).show()

        val host = getServerHost()
        val localApkUrl = "http://$host/aura-vj-projector.apk"
        val githubApkUrl = "https://github.com/MaksymRC1/projector-vj/releases/download/v1.0.0/aura-vj-projector.apk"

        thread(name = "AuraApkDownloader") {
            var downloadUrl = if (checkUrlReachable(localApkUrl)) localApkUrl else githubApkUrl
            try {
                var conn: HttpURLConnection
                var currentUrl = downloadUrl
                var redirects = 0

                // GitHub Releases завжди роздає файли через HTTP 302 на AWS S3 (objects.githubusercontent.com)
                while (true) {
                    val url = URL(currentUrl)
                    conn = url.openConnection() as HttpURLConnection
                    conn.instanceFollowRedirects = true
                    conn.connectTimeout = 15000
                    conn.readTimeout = 60000
                    conn.setRequestProperty("User-Agent", "AuraVJ-Projector/2.7")
                    conn.connect()

                    val code = conn.responseCode
                    if (code in listOf(301, 302, 303, 307, 308) && redirects < 5) {
                        val newLocation = conn.getHeaderField("Location")
                        conn.disconnect()
                        if (newLocation != null) {
                            currentUrl = newLocation
                            redirects++
                            continue
                        }
                    }
                    break
                }

                if (conn.responseCode !in 200..299) {
                    runOnUiThread {
                        Toast.makeText(this, "Помилка сервера завантаження: ${conn.responseCode}", Toast.LENGTH_SHORT).show()
                    }
                    return@thread
                }

                val apkFile = File(cacheDir, "aura-vj-update.apk")
                if (apkFile.exists()) apkFile.delete()

                val input = conn.inputStream
                val output = FileOutputStream(apkFile)
                val buffer = ByteArray(8192)
                var bytesRead: Int
                var totalBytes = 0
                while (input.read(buffer).also { bytesRead = it } != -1) {
                    output.write(buffer, 0, bytesRead)
                    totalBytes += bytesRead
                }
                output.flush()
                output.close()
                input.close()
                conn.disconnect()

                if (totalBytes < 100000) {
                    runOnUiThread {
                        Toast.makeText(this, "Помилка: файл оновлення пошкоджено ($totalBytes байт)", Toast.LENGTH_LONG).show()
                    }
                    return@thread
                }

                runOnUiThread {
                    Toast.makeText(this, "✅ Завантажено (${totalBytes / 1024} КБ)! Запуск встановлення...", Toast.LENGTH_SHORT).show()
                    launchApkInstaller(apkFile)
                }
            } catch (e: Exception) {
                runOnUiThread {
                    Toast.makeText(this, "Помилка завантаження: ${e.message}", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun launchApkInstaller(apkFile: File) {
        try {
            val apkUri: Uri = FileProvider.getUriForFile(
                this,
                "$packageName.provider",
                apkFile
            )

            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(apkUri, "application/vnd.android.package-archive")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION
            }
            startActivity(intent)
        } catch (e: Exception) {
            Toast.makeText(this, "Не вдалося відкрити інсталятор: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    private var lastBackPressTime = 0L

    /**
     * Меню налаштувань для пульта проектора (кнопка MENU / SETTINGS) та обробка кнопки BACK
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_MENU || keyCode == KeyEvent.KEYCODE_SETTINGS) {
            showServerSettingsDialog()
            return true
        }
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            webView.evaluateJavascript("window.onAndroidBackPressed ? window.onAndroidBackPressed() : false;") { result ->
                val consumed = result == "true"
                if (!consumed) {
                    val now = System.currentTimeMillis()
                    if (now - lastBackPressTime < 2000) {
                        finish()
                    } else {
                        lastBackPressTime = now
                        Toast.makeText(this, "Натисніть НАЗАД ще раз для виходу", Toast.LENGTH_SHORT).show()
                    }
                }
            }
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    private fun showServerSettingsDialog() {
        val currentHost = getServerHost()
        val input = EditText(this)
        input.setText(currentHost)
        input.hint = "Наприклад: 192.168.0.40:3456"

        AlertDialog.Builder(this)
            .setTitle("⚙️ AURA VJ — Налаштування LAN")
            .setMessage("Введіть IP-адресу вашого комп'ютера у спільній Wi-Fi мережі:")
            .setView(input)
            .setPositiveButton("Зберегти та перезавантажити") { _, _ ->
                val newHost = input.text.toString().trim()
                if (newHost.isNotEmpty()) {
                    setServerHost(newHost)
                    loadBestAvailableSource()
                }
            }
            .setNeutralButton("Оновити APK з мережі") { _, _ ->
                downloadAndInstallApkUpdate()
            }
            .setNegativeButton("Закрити", null)
            .show()
    }

    private fun checkAndStartSystemAudio() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.RECORD_AUDIO),
                AUDIO_PERMISSION_REQ
            )
        } else {
            initGlobalVisualizer()
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == AUDIO_PERMISSION_REQ &&
            grantResults.isNotEmpty() &&
            grantResults[0] == PackageManager.PERMISSION_GRANTED
        ) {
            initGlobalVisualizer()
        }
    }

    private fun initGlobalVisualizer() {
        try {
            visualizer?.release()
            val vis = Visualizer(0)
            vis.enabled = false
            val captureSizeRange = Visualizer.getCaptureSizeRange()
            vis.captureSize = captureSizeRange[1].coerceAtMost(1024)

            vis.setDataCaptureListener(
                object : Visualizer.OnDataCaptureListener {
                    override fun onWaveFormDataCapture(
                        v: Visualizer?,
                        waveform: ByteArray?,
                        samplingRate: Int
                    ) {}

                    override fun onFftDataCapture(
                        v: Visualizer?,
                        fft: ByteArray?,
                        samplingRate: Int
                    ) {
                        if (fft == null) return
                        val binCount = min(256, fft.size / 2)
                        val sb = StringBuilder("[")
                        for (i in 0 until binCount) {
                            val rfk = fft[2 * i].toInt()
                            val ifk = fft[2 * i + 1].toInt()
                            val magnitude = (hypot(rfk.toDouble(), ifk.toDouble()) * 2.4)
                                .toInt()
                                .coerceIn(0, 255)
                            if (i > 0) sb.append(',')
                            sb.append(magnitude)
                        }
                        sb.append(']')
                        val arrayJs = sb.toString()
                        webView.post {
                            webView.evaluateJavascript(
                                "window.onAndroidNativeFFT && window.onAndroidNativeFFT($arrayJs);",
                                null
                            )
                        }
                    }
                },
                Visualizer.getMaxCaptureRate(),
                false,
                true
            )
            vis.enabled = true
            visualizer = vis
        } catch (e: Exception) {
            webView.post {
                webView.evaluateJavascript(
                    "window.onAndroidAudioFallback && window.onAndroidAudioFallback('DRM session 0 restricted');",
                    null
                )
            }
        }
    }

    private fun hideSystemUI() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN
            )
    }

    override fun onDestroy() {
        embeddedServer?.stop()
        embeddedServer = null
        visualizer?.release()
        visualizer = null
        super.onDestroy()
    }
}
