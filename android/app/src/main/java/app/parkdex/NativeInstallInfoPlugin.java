package app.parkdex;

import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeInstallInfo")
public final class NativeInstallInfoPlugin extends Plugin {
    @PluginMethod
    public void getInstallInfo(PluginCall call) {
        String packageName = getContext().getPackageName();
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(packageName, 0);
            long versionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? info.getLongVersionCode()
                    : info.versionCode;
            JSObject result = new JSObject();
            result.put("packageName", packageName);
            result.put("firstInstallTime", info.firstInstallTime);
            result.put("lastUpdateTime", info.lastUpdateTime);
            result.put("versionCode", versionCode);
            call.resolve(result);
        } catch (PackageManager.NameNotFoundException | RuntimeException error) {
            call.reject("The installed Parkdex package information is unavailable.");
        }
    }
}
