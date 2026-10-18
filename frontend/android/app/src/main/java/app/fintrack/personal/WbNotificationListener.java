package app.fintrack.personal;

import android.app.Notification;
import android.content.ComponentName;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

public final class WbNotificationListener extends NotificationListenerService {
    @Override public void onNotificationPosted(StatusBarNotification event) {
        if (!BankQueue.BANK_PACKAGE.equals(event.getPackageName()) || !BankQueue.settings(this).getBoolean("enabled", false)) return;
        Notification notification = event.getNotification();
        if ((notification.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;
        Bundle extras = notification.extras;
        CharSequence text = extras.getCharSequence(Notification.EXTRA_BIG_TEXT);
        if (text == null || text.length() == 0) text = extras.getCharSequence(Notification.EXTRA_TEXT);
        if (text == null || text.length() == 0) {
            BankQueue.settings(this).edit().putString("listener_error", "WB Банк прислал уведомление без текста. Проверьте покупку вручную.").apply();
            return;
        }
        String body = text.toString().trim();
        if (!body.startsWith("Покупка")) return;
        try {
            if (body.length() > 4000) throw new IllegalArgumentException("Notification too large");
            BankQueue.get(this).capture(this, event.getKey(), notification.when, event.getPostTime(), body);
            BankSyncJob.schedule(this, false);
        } catch (Exception failure) {
            BankQueue.settings(this).edit().putString("listener_error", "Не удалось сохранить пуш. Проверьте покупку вручную.").apply();
        }
    }

    @Override public void onNotificationRemoved(StatusBarNotification event) {
        if (BankQueue.BANK_PACKAGE.equals(event.getPackageName())) BankQueue.get(this).removed(event.getKey());
    }

    @Override public void onListenerConnected() { BankSyncJob.schedule(this, true); }

    @Override public void onListenerDisconnected() {
        if (BankQueue.settings(this).getBoolean("enabled", false)) requestRebind(new ComponentName(this, WbNotificationListener.class));
    }
}
