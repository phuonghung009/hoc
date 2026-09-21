package com.dethihub.englishexam

import android.annotation.SuppressLint
import android.app.Activity
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.webkit.PermissionRequest
import android.os.Bundle
import android.os.Message
import android.print.PrintAttributes
import android.print.PrintManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader

/**
 * App này chỉ có đúng 1 màn hình: 1 WebView load thẳng trang
 * plugins/english_exam_battle/index.html đã có sẵn (y hệt bản Chrome
 * extension) — không viết lại logic gì cả, chỉ "đóng gói" trang đó thành
 * app Android.
 *
 * Vài điểm cần lưu ý khi bọc 1 web app thuần vào WebView:
 *
 * 1) Phục vụ file trong assets/www/ qua địa chỉ ảo
 *    "https://appassets.androidplatform.net/..." (WebViewAssetLoader) thay
 *    vì "file://..." — đây là cách Google khuyến nghị, tránh các lỗi vặt
 *    về CORS/localStorage/IndexedDB hay gặp với file://.
 *
 * 2) Trang gốc dùng window.open('', '_blank') rồi w.print() để "🖨 Xuất
 *    PDF" đề thi/bài chấm. WebView mặc định không có khái niệm "tab mới",
 *    nên phải tự bắt sự kiện onCreateWindow() để tạo 1 WebView ẩn nhận nội
 *    dung đó, rồi thay hàm print() của trang bằng PrintManager của
 *    Android (có sẵn lựa chọn "Lưu dưới dạng PDF" trong hộp thoại in).
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private var printPopup: WebView? = null
    private var pendingPermissionRequest: PermissionRequest? = null
    private var pendingFilePathCallback: android.webkit.ValueCallback<Array<Uri>>? = null
    private val fileChooserRequestCode = 1001
    private val mediaPermissionRequestCode = 1002

    private val assetLoader by lazy {
        WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)
        configureWebView(webView)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)
        }

        webView.webChromeClient = mainChromeClient

        val startUrl =
            "https://appassets.androidplatform.net/assets/www/plugins/english_exam_battle/index.html"
        webView.loadUrl(startUrl)
    }

    // WebChromeClient dùng chung cho webView chính lẫn popup in ấn (để lỡ
    // trang có mở thêm 1 cửa sổ nữa từ trong popup thì vẫn xử lý được).
    private val mainChromeClient = object : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) {
            runOnUiThread {
                val wantsAudio = request.resources?.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE) == true
                val wantsVideo = request.resources?.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE) == true
                if (!wantsAudio && !wantsVideo) {
                    request.deny()
                    return@runOnUiThread
                }

                val missingAudio = wantsAudio && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
                if (missingAudio) {
                    pendingPermissionRequest?.deny()
                    pendingPermissionRequest = request
                    requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), mediaPermissionRequestCode)
                } else {
                    val allowed = request.resources.filter {
                        it == PermissionRequest.RESOURCE_AUDIO_CAPTURE && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                    }.toTypedArray()
                    if (allowed.isNotEmpty()) request.grant(allowed) else request.deny()
                }
            }
        }

        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: android.webkit.ValueCallback<Array<Uri>>?,
            fileChooserParams: WebChromeClient.FileChooserParams
        ): Boolean {
            pendingFilePathCallback?.onReceiveValue(null)
            pendingFilePathCallback = filePathCallback
            return try {
                val intent = fileChooserParams.createIntent().apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                }
                startActivityForResult(intent, fileChooserRequestCode)
                true
            } catch (e: Exception) {
                pendingFilePathCallback = null
                false
            }
        }

        override fun onCreateWindow(
            view: WebView,
            isDialog: Boolean,
            isUserGesture: Boolean,
            resultMsg: Message
        ): Boolean {
            val popup = WebView(this@MainActivity)
            configureWebView(popup)
            popup.webChromeClient = this
            popup.webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    v: WebView,
                    request: WebResourceRequest
                ): WebResourceResponse? = assetLoader.shouldInterceptRequest(request.url)

                override fun onPageFinished(v: WebView, url: String?) {
                    super.onPageFinished(v, url)
                    // Trang popup (đề/bài chấm để in) tự gọi window.print() qua nút
                    // "🖨 In" của nó — thay hàm đó bằng cầu nối gọi sang Android.
                    v.evaluateJavascript(
                        "window.print = function(){ AndroidPrint.doPrint(); };",
                        null
                    )
                }
            }
            popup.addJavascriptInterface(
                PrintBridge { runOnUiThread { printWebView(popup) } },
                "AndroidPrint"
            )

            printPopup = popup
            val transport = resultMsg.obj as WebView.WebViewTransport
            transport.webView = popup
            resultMsg.sendToTarget()
            return true
        }

        override fun onCloseWindow(window: WebView) {
            if (window === printPopup) {
                try { window.destroy() } catch (_: Exception) { }
                printPopup = null
            }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == mediaPermissionRequestCode) {
            val request = pendingPermissionRequest
            pendingPermissionRequest = null
            if (request != null) {
                if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                    val allowed = request.resources.filter {
                        it == PermissionRequest.RESOURCE_AUDIO_CAPTURE && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                    }.toTypedArray()
                    if (allowed.isNotEmpty()) request.grant(allowed) else request.deny()
                } else {
                    request.deny()
                }
            }
        }
    }

    @Deprecated("Deprecated in Android API 29; kept for compatibility with WebView file chooser")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == fileChooserRequestCode) {
            val callback = pendingFilePathCallback
            pendingFilePathCallback = null
            callback?.onReceiveValue(
                if (resultCode == RESULT_OK) WebChromeClient.FileChooserParams.parseResult(resultCode, data) else null
            )
        }
    }

    private class PrintBridge(private val onPrint: () -> Unit) {
        @JavascriptInterface
        fun doPrint() = onPrint()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView(wv: WebView) {
        wv.settings.javaScriptEnabled = true
        wv.settings.domStorageEnabled = true
        wv.settings.databaseEnabled = true
        wv.settings.javaScriptCanOpenWindowsAutomatically = true
        wv.settings.setSupportMultipleWindows(true)
        wv.settings.mediaPlaybackRequiresUserGesture = false
        wv.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        wv.settings.cacheMode = WebSettings.LOAD_DEFAULT
    }

    private fun printWebView(target: WebView) {
        val printManager = getSystemService(PRINT_SERVICE) as PrintManager
        val jobName = getString(R.string.app_name) + " - " + System.currentTimeMillis()
        val adapter = target.createPrintDocumentAdapter(jobName)
        printManager.print(jobName, adapter, PrintAttributes.Builder().build())
    }

    override fun onDestroy() {
        pendingPermissionRequest?.deny()
        pendingPermissionRequest = null
        pendingFilePathCallback?.onReceiveValue(null)
        pendingFilePathCallback = null
        try { printPopup?.destroy() } catch (_: Exception) { }
        printPopup = null
        try {
            webView.stopLoading()
            webView.destroy()
        } catch (_: Exception) { }
        super.onDestroy()
    }

    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }
}
