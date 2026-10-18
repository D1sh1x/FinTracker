package app.fintrack.personal;

import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.UUID;

@CapacitorPlugin(name = "BankNotifications")
public final class BankNotificationsPlugin extends Plugin {
    @PluginMethod public void status(PluginCall call) {
        try {
            SharedPreferences config = BankQueue.settings(getContext());
            JSObject result = new JSObject(BankQueue.get(getContext()).snapshot().toString());
            result.put("enabled", config.getBoolean("enabled", false));
            result.put("access", NotificationManagerCompat.getEnabledListenerPackages(getContext()).contains(getContext().getPackageName()));
            for (String key : new String[]{"profile_id","profile_name","wallet_id","wallet_name","server","listener_error"}) result.put(key, config.getString(key,""));
            call.resolve(result);
        } catch (Exception failure) { call.reject("Не удалось прочитать журнал уведомлений"); }
    }

    @PluginMethod public void configure(PluginCall call) {
        try {
            boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
            SharedPreferences config = BankQueue.settings(getContext());
            if (!enabled) {
                if (!config.edit().putBoolean("enabled", false).commit()) throw new IllegalStateException("Settings write failed");
                BankSyncJob.pause(getContext()); call.resolve(); return;
            }
            String profile = call.getString("profile_id", ""), wallet = call.getString("wallet_id", "");
            UUID.fromString(profile); UUID.fromString(wallet);
            String server = FintrackDevicePlugin.loadConnection(getContext()).getString("url");
            if (server.isEmpty()) throw new IllegalStateException("No server");
            if (!config.edit().putBoolean("enabled", true).putString("profile_id", profile).putString("wallet_id", wallet)
                .putString("profile_name", call.getString("profile_name", "")).putString("wallet_name", call.getString("wallet_name", ""))
                .putString("server", server).putLong("started_at", System.currentTimeMillis()).putString("listener_error", "").commit()) throw new IllegalStateException("Settings write failed");
            NotificationListenerService.requestRebind(new ComponentName(getContext(), WbNotificationListener.class));
            BankSyncJob.schedule(getContext(), true); BankSyncJob.schedule(getContext(), false);
            call.resolve();
        } catch (Exception failure) { call.reject("Не удалось включить автоимпорт. Проверьте профиль, счёт и подключение"); }
    }

    @PluginMethod public void openAccess(PluginCall call) {
        try { getActivity().startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)); call.resolve(); }
        catch (Exception failure) { call.reject("Откройте настройки Android → Специальный доступ → Доступ к уведомлениям"); }
    }

    @PluginMethod public void sync(PluginCall call) { BankSyncJob.schedule(getContext(),false); call.resolve(); }
}
