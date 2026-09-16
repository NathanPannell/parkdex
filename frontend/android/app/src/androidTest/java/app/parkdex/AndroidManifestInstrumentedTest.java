package app.parkdex;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.Manifest;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.content.res.XmlResourceParser;

import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

import androidx.test.ext.junit.runners.AndroidJUnit4;

@RunWith(AndroidJUnit4.class)
public class AndroidManifestInstrumentedTest {
    @Test
    public void declaresForegroundLocationWithoutBackgroundOrBroadMediaAccess() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        PackageInfo packageInfo = context.getPackageManager().getPackageInfo(
            context.getPackageName(),
            PackageManager.GET_PERMISSIONS
        );
        Set<String> requested = new HashSet<>(Arrays.asList(packageInfo.requestedPermissions));

        assertTrue(requested.contains(Manifest.permission.ACCESS_COARSE_LOCATION));
        assertTrue(requested.contains(Manifest.permission.ACCESS_FINE_LOCATION));
        assertFalse(requested.contains(Manifest.permission.ACCESS_BACKGROUND_LOCATION));
        assertFalse(requested.contains(Manifest.permission.CAMERA));
        assertFalse(requested.contains(Manifest.permission.READ_MEDIA_IMAGES));
        assertFalse(requested.contains(Manifest.permission.READ_EXTERNAL_STORAGE));
        assertFalse(requested.contains(Manifest.permission.WRITE_EXTERNAL_STORAGE));
    }

    @Test
    public void disablesAndroidBackupAndKeepsBothFileProvidersPrivate() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals(0, context.getApplicationInfo().flags & ApplicationInfo.FLAG_ALLOW_BACKUP);

        PackageInfo packageInfo = context.getPackageManager().getPackageInfo(
            context.getPackageName(),
            PackageManager.GET_PROVIDERS
        );
        ProviderInfo appProvider = null;
        ProviderInfo cameraProvider = null;
        for (ProviderInfo provider : packageInfo.providers) {
            if ((context.getPackageName() + ".fileprovider").equals(provider.authority)) appProvider = provider;
            if ((context.getPackageName() + ".camera.provider").equals(provider.authority)) cameraProvider = provider;
        }

        assertPrivateGrantingProvider(appProvider);
        assertPrivateGrantingProvider(cameraProvider);
    }

    @Test
    public void fileProviderResourcesExposeOnlyRequiredAppDirectories() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertPathResource(context, "file_paths", "external-files-path", "Pictures/");
        assertPathResource(context, "ioncamera_paths", "cache-path", ".");
    }

    private static void assertPrivateGrantingProvider(ProviderInfo provider) {
        assertNotNull(provider);
        assertFalse(provider.exported);
        assertTrue(provider.grantUriPermissions);
    }

    private static void assertPathResource(Context context, String resourceName, String expectedTag, String expectedPath) throws Exception {
        int resourceId = context.getResources().getIdentifier(resourceName, "xml", context.getPackageName());
        assertTrue(resourceId != 0);
        try (XmlResourceParser parser = context.getResources().getXml(resourceId)) {
            int pathEntries = 0;
            for (int event = parser.getEventType(); event != XmlResourceParser.END_DOCUMENT; event = parser.next()) {
                if (event != XmlResourceParser.START_TAG || "paths".equals(parser.getName())) continue;
                pathEntries += 1;
                assertEquals(expectedTag, parser.getName());
                assertEquals(expectedPath, parser.getAttributeValue(null, "path"));
            }
            assertEquals(1, pathEntries);
        }
    }
}
