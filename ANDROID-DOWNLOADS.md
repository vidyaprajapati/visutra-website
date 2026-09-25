# Downloads inside the VISUTRA Android app

## Why files don't download in the app
Every page saves files the browser way — Label Cropper's cropped PDF, invoice
PDFs, every Excel export. The browser creates a temporary `blob:` link and
"clicks" it. **Chrome** saves that file. An Android **WebView** (your app)
ignores it unless the app has code for it — so in the app, nothing happens.

The website side is already done: `billing/assets/android-download.js` (loaded
on every page that saves files) catches those downloads and hands the file to
the app **if** the app provides `AndroidBridge.saveFile(...)`. In an app build
without it, the page shows: *"If the file didn't download, update the VISUTRA
app — or open visutra.in in Chrome."*

## Add this to the app (Kotlin) — about 5 minutes

### 1. New file `AndroidBridge.kt` (same package as your MainActivity)
```kotlin
import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import android.webkit.JavascriptInterface
import android.widget.Toast
import java.io.File

class AndroidBridge(private val context: Context) {

    @JavascriptInterface
    fun saveFile(base64: String, fileName: String, mimeType: String) {
        try {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // Android 10+ : Downloads via MediaStore — no storage permission needed
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, fileName)
                    put(MediaStore.Downloads.MIME_TYPE, mimeType)
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = context.contentResolver
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw Exception("Could not create file")
                resolver.openOutputStream(uri)?.use { it.write(bytes) }
                values.clear()
                values.put(MediaStore.Downloads.IS_PENDING, 0)
                resolver.update(uri, values, null, null)
            } else {
                // Android 9 and older — needs WRITE_EXTERNAL_STORAGE (see step 3)
                @Suppress("DEPRECATION")
                val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                File(dir, fileName).writeBytes(bytes)
            }
            toast("Saved to Downloads: $fileName")
        } catch (e: Exception) {
            toast("Could not save $fileName: ${e.message}")
        }
    }

    private fun toast(msg: String) =
        Handler(Looper.getMainLooper()).post { Toast.makeText(context, msg, Toast.LENGTH_LONG).show() }
}
```

### 2. In `MainActivity`, where the WebView is set up
```kotlin
webView.settings.javaScriptEnabled = true          // already on for the site
webView.addJavascriptInterface(AndroidBridge(this), "AndroidBridge")
```
The name must be exactly **`AndroidBridge`**.

### 3. `AndroidManifest.xml` — only if you support Android 9 or older
```xml
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE"
                 android:maxSdkVersion="28" />
```

### 4. Build, install, test
Open Label Cropper in the app → Crop & download → a toast says
**"Saved to Downloads: visutra-…-labels-….pdf"** and the file is in the
phone's Downloads folder. Try an invoice PDF and an Excel export too.

## Notes
- Nothing changes in a normal browser — the website script only acts inside the app.
- `addJavascriptInterface` is safe here because the WebView only loads your
  own site (visutra.in). If the app can open other websites inside the same
  WebView, only add the bridge when the URL is visutra.in.
