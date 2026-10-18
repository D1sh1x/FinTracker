package app.fintrack.personal;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FintrackDevicePlugin.class);
        registerPlugin(BankNotificationsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
