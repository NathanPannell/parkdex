package app.parkdex.content;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import app.parkdex.BuildConfig;

import org.junit.Test;

public class WifiContentTransportPluginTest {
    private static final String CDN_ORIGIN = "https://kip-assets.parkdex.app";

    @Test
    public void permitsPinnedContentOriginsAndExactConfiguredPreviewHost() throws Exception {
        assertEquals("https://parkdex-kip-staging.vercel.app/api/content/current",
                WifiContentTransportPlugin.validateContentUrl(
                        "https://parkdex-kip-staging.vercel.app/api/content/current",
                        "https://parkdex-kip-staging.vercel.app",
                        CDN_ORIGIN).toString());
        assertEquals("https://parkdex-kip.vercel.app/api/content/current",
                WifiContentTransportPlugin.validateContentUrl(
                        "https://parkdex-kip.vercel.app/api/content/current",
                        "https://parkdex-kip.vercel.app",
                        CDN_ORIGIN).toString());
        assertEquals("https://kip-assets.parkdex.app/releases/v1/chunk.bin",
                WifiContentTransportPlugin.validateContentUrl(
                        "https://kip-assets.parkdex.app/releases/v1/chunk.bin",
                        "https://parkdex-kip-staging.vercel.app",
                        CDN_ORIGIN).toString());

        if (!BuildConfig.CONTENT_API_HOST.isEmpty()) {
            String previewOrigin = "https://" + BuildConfig.CONTENT_API_HOST;
            assertEquals(previewOrigin + "/api/content/current",
                    WifiContentTransportPlugin.validateContentUrl(
                            previewOrigin + "/api/content/current",
                            previewOrigin,
                            CDN_ORIGIN).toString());
        }
    }

    @Test
    public void rejectsUnconfiguredPreviewHostsAndRedirectTargets() {
        assertThrows(Exception.class, () -> WifiContentTransportPlugin.validateContentUrl(
                "https://parkdex-kip-a1b2c3d4e-unrelated.vercel.app/api/content/current",
                "https://parkdex-kip-a1b2c3d4e-unrelated.vercel.app",
                CDN_ORIGIN));
        assertThrows(Exception.class, () -> WifiContentTransportPlugin.validateContentUrl(
                "https://attacker.example/api/content/current",
                "https://parkdex-kip-staging.vercel.app",
                CDN_ORIGIN));
        assertThrows(Exception.class, () -> WifiContentTransportPlugin.validateContentUrl(
                "http://parkdex-kip-staging.vercel.app/api/content/current",
                "https://parkdex-kip-staging.vercel.app",
                CDN_ORIGIN));
    }
}
