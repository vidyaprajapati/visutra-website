package in.visutra.app;

import android.content.ContentValues;
import android.content.Context;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import android.content.Intent;
import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/** Lets the website save files (label PDFs, invoices, Excel) to the phone's Downloads folder. */
public class AndroidBridge {
    private final Context context;
    public AndroidBridge(Context context) { this.context = context; }

    @JavascriptInterface
    public void saveFile(String base64, String fileName, String mimeType) {
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            String name = fileName == null || fileName.isEmpty() ? "download" : fileName.replaceAll("[\\\\/:*?\"<>|]", "_");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                values.put(MediaStore.Downloads.MIME_TYPE, mimeType == null ? "application/octet-stream" : mimeType);
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                android.net.Uri uri = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new Exception("Could not create file");
                try (OutputStream os = context.getContentResolver().openOutputStream(uri)) { os.write(bytes); }
                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                context.getContentResolver().update(uri, values, null, null);
            } else {
                File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                dir.mkdirs();
                try (FileOutputStream os = new FileOutputStream(new File(dir, name))) { os.write(bytes); }
            }
            toast("Saved to Downloads: " + name);
        } catch (Exception e) {
            toast("Could not save file: " + e.getMessage());
        }
    }

    /** Share a file (statement PDF) — straight to WhatsApp (or WhatsApp Business) chat of `phone` if given, else the share sheet. */
    @JavascriptInterface
    public void shareFile(String base64, String fileName, String mimeType, String phone, String text) {
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            String name = fileName == null || fileName.isEmpty() ? "share.pdf" : fileName.replaceAll("[\\\\/:*?\"<>|]", "_");
            File dir = new File(context.getCacheDir(), "shared");
            dir.mkdirs();
            File f = new File(dir, name);
            try (FileOutputStream os = new FileOutputStream(f)) { os.write(bytes); }
            android.net.Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", f);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mimeType == null ? "application/pdf" : mimeType);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            if (text != null) send.putExtra(Intent.EXTRA_TEXT, text);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (!(context instanceof android.app.Activity)) send.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            boolean started = false;
            if (phone != null && !phone.isEmpty()) {
                send.putExtra("jid", phone + "@s.whatsapp.net");
                for (String pkg : new String[]{"com.whatsapp", "com.whatsapp.w4b"}) {
                    try { Intent i = new Intent(send); i.setPackage(pkg); context.startActivity(i); started = true; break; }
                    catch (android.content.ActivityNotFoundException ignored) { }
                }
            }
            if (!started) {
                Intent chooser = Intent.createChooser(send, "Send statement");
                if (!(context instanceof android.app.Activity)) chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(chooser);
            }
        } catch (Exception e) {
            toast("Could not share file: " + e.getMessage());
        }
    }

    private void toast(final String msg) {
        new Handler(Looper.getMainLooper()).post(new Runnable() {
            @Override public void run() { Toast.makeText(context, msg, Toast.LENGTH_LONG).show(); }
        });
    }
}
