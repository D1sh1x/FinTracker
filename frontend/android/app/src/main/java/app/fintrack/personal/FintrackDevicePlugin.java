package app.fintrack.personal;

import android.app.Activity;
import android.content.Context;
import android.content.ClipboardManager;
import android.content.ClipData;
import android.content.Intent;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.appcompat.app.AppCompatDelegate;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "FintrackDevice")
public class FintrackDevicePlugin extends Plugin {
    private static final String PREFERENCES = "fintrack_connection";
    private static final String KEY_ALIAS = "fintrack_connection_key";
    private static final int GCM_TAG_BITS = 128;

    private SecretKey secretKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return (SecretKey) store.getKey(KEY_ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build());
        return generator.generateKey();
    }

    @PluginMethod
    public void readConnection(PluginCall call) {
        try {
            String stored = getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString("encrypted", null);
            if (stored == null) {
                JSObject empty = new JSObject();
                empty.put("url", ""); empty.put("username", ""); empty.put("password", "");
                call.resolve(empty);
                return;
            }
            String[] parts = stored.split(":", 2);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(GCM_TAG_BITS, Base64.decode(parts[0], Base64.NO_WRAP)));
            String json = new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
            call.resolve(new JSObject(json));
        } catch (Exception failure) {
            call.reject("Не удалось прочитать настройки подключения.");
        }
    }

    @PluginMethod
    public void saveConnection(PluginCall call) {
        try {
            String address = call.getString("url", "");
            URI uri = new URI(address);
            String host = uri.getHost();
            boolean loopback = "localhost".equals(host) || "127.0.0.1".equals(host) || "10.0.2.2".equals(host);
            if (host == null || (!"https".equals(uri.getScheme()) && !(loopback && "http".equals(uri.getScheme()))) ||
                uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null ||
                (uri.getPath() != null && !uri.getPath().isEmpty() && !"/".equals(uri.getPath()))) {
                call.reject("Укажите HTTPS-адрес сервера или локальный туннель.");
                return;
            }
            JSObject settings = new JSObject();
            settings.put("url", address);
            settings.put("username", call.getString("username", ""));
            settings.put("password", call.getString("password", ""));
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, secretKey());
            String encrypted = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" +
                Base64.encodeToString(cipher.doFinal(settings.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
            boolean committed = getContext().getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putString("encrypted", encrypted).commit();
            if (!committed) throw new IllegalStateException("Settings write failed");
            call.resolve();
        } catch (Exception failure) {
            call.reject("Не удалось сохранить настройки подключения.");
        }
    }

    @PluginMethod
    public void setTheme(PluginCall call) {
        String theme = call.getString("theme", "system");
        int mode = "dark".equals(theme) ? AppCompatDelegate.MODE_NIGHT_YES :
            "light".equals(theme) ? AppCompatDelegate.MODE_NIGHT_NO : AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM;
        getActivity().runOnUiThread(() -> {
            AppCompatDelegate.setDefaultNightMode(mode);
            call.resolve();
        });
    }

    @PluginMethod
    public void pasteImage(PluginCall call) {
        try {
            ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = clipboard.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0 || clip.getItemAt(0).getUri() == null) {
                call.reject("В буфере нет изображения. Скопируйте скриншот или выберите файл.");
                return;
            }
            String mimeType = getContext().getContentResolver().getType(clip.getItemAt(0).getUri());
            if (!"image/png".equals(mimeType) && !"image/jpeg".equals(mimeType)) {
                call.reject("Поддерживаются изображения PNG и JPEG.");
                return;
            }
            try (InputStream stream = getContext().getContentResolver().openInputStream(clip.getItemAt(0).getUri());
                 ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                if (stream == null) throw new IllegalStateException("Clipboard image unavailable");
                byte[] chunk = new byte[16384];
                int count;
                while ((count = stream.read(chunk)) != -1) {
                    if (bytes.size() + count > 10 * 1024 * 1024) {
                        call.reject("Скриншот не должен превышать 10 МБ.");
                        return;
                    }
                    bytes.write(chunk, 0, count);
                }
                JSObject result = new JSObject();
                result.put("mimeType", mimeType);
                result.put("base64", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
                call.resolve(result);
            }
        } catch (Exception failure) {
            call.reject("Не удалось прочитать изображение из буфера. Выберите файл.");
        }
    }

    @PluginMethod
    public void saveCsv(PluginCall call) {
        String text = call.getString("text");
        if (text == null) {
            call.reject("Пустой файл экспорта.");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("text/csv");
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "fintrack.csv"));
        startActivityForResult(call, intent, "csvCreated");
    }

    @ActivityCallback
    private void csvCreated(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject response = new JSObject();
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            response.put("saved", false);
            call.resolve(response);
            return;
        }
        getBridge().execute(() -> {
            try (OutputStream stream = getContext().getContentResolver().openOutputStream(result.getData().getData())) {
                if (stream == null) throw new IllegalStateException("No output stream");
                stream.write(call.getString("text", "").getBytes(StandardCharsets.UTF_8));
                response.put("saved", true);
                call.resolve(response);
            } catch (Exception failure) {
                call.reject("Не удалось сохранить CSV. Повторите экспорт.");
            }
        });
    }
}
