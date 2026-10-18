package fixture;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Bundle;

public final class MainActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("purchases", "Synthetic test purchases", NotificationManager.IMPORTANCE_DEFAULT));
        int id = getIntent().getIntExtra("id", 1);
        long when = getIntent().getLongExtra("when", System.currentTimeMillis());
        String mode = getIntent().getStringExtra("mode");
        if ("remove".equals(mode)) { manager.cancel(id); finish(); return; }
        String text = "invalid".equals(mode) ? "Покупка: сумма скрыта. Доступно 933,48 ₽" :
            "unknown".equals(mode) ? "Покупка 43 ₽ по карте *7055 Неизвестный магазин. Доступно 933,48 ₽" :
            "Покупка 43 ₽ по карте *7055 Транспорт Краснодара. Доступно 933,48 ₽";
        manager.notify(id, new Notification.Builder(this, "purchases")
            .setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle("WB Банк").setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text)).setWhen(when).setOnlyAlertOnce(true).build());
        finish();
    }
}
