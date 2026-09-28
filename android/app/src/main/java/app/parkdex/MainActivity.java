package app.parkdex;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import app.parkdex.content.WifiContentTransportPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeIdentityPlugin.class);
        registerPlugin(WifiContentTransportPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
