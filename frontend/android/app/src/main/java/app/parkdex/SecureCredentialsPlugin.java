package app.parkdex;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

@CapacitorPlugin(name = "SecureCredentials")
public class SecureCredentialsPlugin extends Plugin {
    private static final Set<String> ALLOWED_KEYS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "every-park:account-token:v1",
        "every-park:collection-key:v1",
        "parkdex:google-code-verifier:v1"
    )));

    private SecureCredentialsStore store;

    @Override
    public void load() {
        store = new SecureCredentialsStore(getContext());
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = allowedKey(call);
        if (key == null) return;
        try {
            JSObject result = new JSObject();
            String value = store.get(key);
            result.put("value", value == null ? JSONObject.NULL : value);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Secure credential could not be read.", error);
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = allowedKey(call);
        if (key == null) return;
        String value = call.getString("value");
        if (value == null) {
            call.reject("A credential value is required.");
            return;
        }
        try {
            store.set(key, value);
            call.resolve();
        } catch (Exception error) {
            call.reject("Secure credential could not be saved.", error);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = allowedKey(call);
        if (key == null) return;
        try {
            store.remove(key);
            call.resolve();
        } catch (Exception error) {
            call.reject("Secure credential could not be removed.", error);
        }
    }

    private String allowedKey(PluginCall call) {
        String key = call.getString("key");
        if (key == null || !ALLOWED_KEYS.contains(key)) {
            call.reject("Unsupported secure credential key.");
            return null;
        }
        return key;
    }
}
