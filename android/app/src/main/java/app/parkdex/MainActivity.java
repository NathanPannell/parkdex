package app.parkdex;

import com.getcapacitor.BridgeActivity;
import app.parkdex.content.WifiContentTransportPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(WifiContentTransportPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
