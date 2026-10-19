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

    private lateinit var prefs: SharedPreferences
    private val PREF_KEY_SERVER_HOST = "server_host"
    private val DEFAULT_SERVER_HOST = "192.168.0.40:3456"

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        prefs = getSharedPreferences("aura_vj_prefs", Context.MODE_PRIVATE)

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

        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedError(
                view: WebView?,
                errorCode: Int,
                description: String?,
                failingUrl: String?
            ) {
                // Якщо локальний сервер недоступний — перемикаємось на офлайн ассети
                if (failingUrl != null && !failingUrl.startsWith("file:///android_asset")) {
                    view?.loadUrl("file:///android_asset/index.html?view=projector")
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                request.grant(request.resources)
            }
        }

        webView.addJavascriptInterface(AndroidAudioBridge(), "AndroidAudioBridge")

        // Завантажуємо найкраще доступне джерело (LAN Server -> GitHub Live -> Offline Asset)
        loadBestAvailableSource()

        checkAndStartSystemAudio()
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
     * 1. Якщо запущено node server.js на комп'ютері — вантажимо прямо з нього (0 ms затримки).
     * 2. Якщо сервер вимкнено, але є інтернет — вантажимо свіжу версію з GitHub.
     * 3. Якщо інтернету немає взагалі — вантажимо вбудований офлайн-ассет.
     */
    private fun loadBestAvailableSource() {
        val host = getServerHost()
        thread {
            val lanUrl = "http://$host/?view=projector"
            val isLanReachable = checkUrlReachable("http://$host/")

            runOnUiThread {
                if (isLanReachable) {
                    Toast.makeText(this, "⚡ Підключено до LAN: $host", Toast.LENGTH_SHORT).show()
                    webView.loadUrl(lanUrl)
                } else {
                    thread {
                        val githubUrl = "https://maksymrc1.github.io/projector-vj/index.html?view=projector&lan=$host"
                        val isOnlineReachable = checkUrlReachable("https://maksymrc1.github.io/projector-vj/index.html")
                        runOnUiThread {
                            if (isOnlineReachable) {
                                webView.loadUrl(githubUrl)
                            } else {
                                webView.loadUrl("file:///android_asset/index.html?view=projector")
                            }
                        }
                    }
                }
            }
        }
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
        fun getAppVersion(): String = "2.7.0"
    }

    /**
     * Оновлення APK безпосередньо всередині додатка без комп'ютера чи флешки
     */
    private fun downloadAndInstallApkUpdate() {
        Toast.makeText(this, "⬇️ Завантаження оновлення AURA VJ...", Toast.LENGTH_LONG).show()

        val host = getServerHost()
        // Спочатку шукаємо APK на локальному сервері, якщо немає — на GitHub Releases
        val localApkUrl = "http://$host/aura-vj-projector.apk"
        val githubApkUrl = "https://github.com/MaksymRC1/projector-vj/releases/download/v1.0.0/aura-vj-projector.apk"

        thread {
            var downloadUrl = if (checkUrlReachable(localApkUrl)) localApkUrl else githubApkUrl
            try {
                val url = URL(downloadUrl)
                val conn = url.openConnection() as HttpURLConnection
                conn.connectTimeout = 10000
                conn.readTimeout = 30000
                conn.connect()

                if (conn.responseCode !in 200..399) {
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
                while (input.read(buffer).also { bytesRead = it } != -1) {
                    output.write(buffer, 0, bytesRead)
                }
                output.flush()
                output.close()
                input.close()

                runOnUiThread {
                    Toast.makeText(this, "✅ Завантажено! Запуск встановлення...", Toast.LENGTH_SHORT).show()
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

    /**
     * Меню налаштувань для пульта проектора (кнопка MENU / SETTINGS)
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_MENU || keyCode == KeyEvent.KEYCODE_SETTINGS) {
            showServerSettingsDialog()
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
        visualizer?.release()
        visualizer = null
        super.onDestroy()
    }
}
