package app.parkdex;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeIdentityPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
