package com.auravj.projector

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.media.audiofx.Visualizer
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import kotlin.math.hypot
import kotlin.math.min

/**
 * Нативний контейнер AURA VJ для Android-проекторів та Smart TV.
 * Перехоплює системний аудіомікшер (YouTube Music, Cast, Spotify) через Visualizer(0)
 * і передає спектр частот у WebGL-шейдер 60 разів на секунду.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var visualizer: Visualizer? = null
    private val AUDIO_PERMISSION_REQ = 1001

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Утримуємо екран проектора завжди увімкненим
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

        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        webView.webViewClient = WebViewClient()
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                request.grant(request.resources)
            }
        }

        webView.addJavascriptInterface(AndroidAudioBridge(), "AndroidAudioBridge")
        webView.loadUrl("file:///android_asset/index.html?view=projector")

        checkAndStartSystemAudio()
    }

    inner class AndroidAudioBridge {
        @JavascriptInterface
        fun startSystemAudio() {
            runOnUiThread { checkAndStartSystemAudio() }
        }
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

    /**
     * Підключення до глобального аудіомікшера Android (audioSession = 0)
     * Дозволяє візуалізувати YouTube Music, Google Cast, Spotify без мікрофона!
     */
    private fun initGlobalVisualizer() {
        try {
            visualizer?.release()
            // Session ID 0 = Master Output Mix всього пристрою Android
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
            e.printStackTrace()
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
