package app.parkdex.content;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertThrows;

import app.parkdex.BuildConfig;

import org.junit.Test;

import java.util.HashMap;
import java.util.Map;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class WifiContentTransportPluginTest {
    private static final String CDN_ORIGIN = "https://kip-assets.parkdex.app";

    @Test
    public void keepsRequestsRunningWhileAPermissionDialogPausesTheActivity() {
        WifiContentTransportPlugin plugin = new WifiContentTransportPlugin();
        assertTrue(plugin.acceptsRequests());

        plugin.handleOnPause();
        assertTrue(plugin.acceptsRequests());
        plugin.handleOnResume();
        assertTrue(plugin.acceptsRequests());
    }

    @Test
    public void stopsRequestsWhenTheActivityStopsAndAllowsThemAgainOnStart() {
        WifiContentTransportPlugin plugin = new WifiContentTransportPlugin();

        plugin.handleOnPause();
        plugin.handleOnStop();
        assertFalse(plugin.acceptsRequests());
        plugin.handleOnStart();
        assertTrue(plugin.acceptsRequests());

        plugin.handleOnStop();
        plugin.handleOnResume();
        assertTrue(plugin.acceptsRequests());
    }

    @Test
    public void neverAllowsRequestsAfterDestroy() {
        WifiContentTransportPlugin plugin = new WifiContentTransportPlugin();

        plugin.handleOnDestroy();
        plugin.handleOnStart();
        plugin.handleOnResume();
        assertFalse(plugin.acceptsRequests());
    }

    @Test
    public void permitsPinnedContentOriginsAndExactConfiguredPreviewHost() throws Exception {
        assertEquals("https://staging.web.parkdex.app/api/content/current",
                WifiContentTransportPlugin.validateContentUrl(
                        "https://staging.web.parkdex.app/api/content/current",
                        "https://staging.web.parkdex.app",
                        CDN_ORIGIN).toString());
        assertEquals("https://web.parkdex.app/api/content/current",
                WifiContentTransportPlugin.validateContentUrl(
                        "https://web.parkdex.app/api/content/current",
                        "https://web.parkdex.app",
                        CDN_ORIGIN).toString());
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

    @Test
    public void reservesWifiForDetailedMapChunksAndUsesAnyValidatedNetworkForOtherContentAndBackup() throws Exception {
        String apiOrigin = "https://parkdex-kip-staging.vercel.app";
        String mapChunk = "https://kip-assets.parkdex.app/releases/release-1/map/island/001.bin";
        String malformedMapChunk = "https://kip-assets.parkdex.app/releases/release-1/map/island/not-numeric.bin";
        String encodedMapChunk = "https://kip-assets.parkdex.app/releases/release-1/%6Dap/island/manifest-ish.bin?cache=1";
        String mapManifest = "https://kip-assets.parkdex.app/releases/release-1/map/island/manifest.json";
        String badgeArt = "https://kip-assets.parkdex.app/releases/release-1/badges/sample.webp";
        String mapFont = "https://kip-assets.parkdex.app/releases/release-1/map/fonts/regular.pbf";

        assertEquals(WifiContentTransportPlugin.NetworkPolicy.WIFI_VALIDATED,
                WifiContentTransportPlugin.networkPolicyForRequest(
                        WifiContentTransportPlugin.validateContentUrl(mapChunk, apiOrigin, CDN_ORIGIN), false));
        assertEquals(WifiContentTransportPlugin.NetworkPolicy.WIFI_VALIDATED,
                WifiContentTransportPlugin.networkPolicyForRequest(
                        WifiContentTransportPlugin.validateContentUrl(malformedMapChunk, apiOrigin, CDN_ORIGIN), false));
        assertEquals(WifiContentTransportPlugin.NetworkPolicy.WIFI_VALIDATED,
                WifiContentTransportPlugin.networkPolicyForRequest(
                        WifiContentTransportPlugin.validateContentUrl(encodedMapChunk, apiOrigin, CDN_ORIGIN), false));

        assertEquals(WifiContentTransportPlugin.NetworkPolicy.ANY_VALIDATED,
                WifiContentTransportPlugin.networkPolicyForRequest(
                        WifiContentTransportPlugin.validateContentUrl(
                                apiOrigin + "/api/content/current", apiOrigin, CDN_ORIGIN), false));
        assertEquals(WifiContentTransportPlugin.NetworkPolicy.ANY_VALIDATED,
                WifiContentTransportPlugin.networkPolicyForRequest(
                        WifiContentTransportPlugin.validateContentUrl(mapManifest, apiOrigin, CDN_ORIGIN), false));
        assertEquals(WifiContentTransportPlugin.NetworkPolicy.ANY_VALIDATED,
                WifiContentTransportPlugin.networkPolicyForRequest(
                        WifiContentTransportPlugin.validateContentUrl(badgeArt, apiOrigin, CDN_ORIGIN), false));
        assertEquals(WifiContentTransportPlugin.NetworkPolicy.ANY_VALIDATED,
                WifiContentTransportPlugin.networkPolicyForRequest(
                        WifiContentTransportPlugin.validateContentUrl(mapFont, apiOrigin, CDN_ORIGIN), false));

        // Nearby and streamed detail opts in to any validated network.
        assertEquals(WifiContentTransportPlugin.NetworkPolicy.ANY_VALIDATED,
                WifiContentTransportPlugin.networkPolicyForRequest(
                        WifiContentTransportPlugin.validateContentUrl(mapChunk, apiOrigin, CDN_ORIGIN), false, true));
        assertEquals(WifiContentTransportPlugin.NetworkPolicy.WIFI_VALIDATED,
                WifiContentTransportPlugin.networkPolicyForRequest(
                        WifiContentTransportPlugin.validateContentUrl(mapChunk, apiOrigin, CDN_ORIGIN), false, false));

        String claimUrl = apiOrigin + "/api/claims";
        assertEquals(WifiContentTransportPlugin.NetworkPolicy.ANY_VALIDATED,
                WifiContentTransportPlugin.networkPolicyForRequest(
                        WifiContentTransportPlugin.validateAccountBackupUrl(claimUrl, apiOrigin, "GET"), true));
    }

    @Test
    public void permitsOnlyExactAccountBackupRoutesAndMethods() throws Exception {
        String productionOrigin = "https://web.parkdex.app";
        assertEquals(productionOrigin + "/api/claims",
                WifiContentTransportPlugin.validateAccountBackupUrl(
                        productionOrigin + "/api/claims", productionOrigin, "GET").toString());
        String origin = "https://parkdex-kip-staging.vercel.app";
        String claimId = "33333333-3333-4333-8333-333333333333";
        assertEquals(origin + "/api/claims",
                WifiContentTransportPlugin.validateAccountBackupUrl(
                        origin + "/api/claims", origin, "GET").toString());
        assertEquals(origin + "/api/claims?cursor=revision_1",
                WifiContentTransportPlugin.validateAccountBackupUrl(
                        origin + "/api/claims?cursor=revision_1", origin, "GET").toString());
        assertEquals(origin + "/api/claims/" + claimId,
                WifiContentTransportPlugin.validateAccountBackupUrl(
                        origin + "/api/claims/" + claimId, origin, "PUT").toString());
        assertEquals(origin + "/api/claims/" + claimId + "/photo",
                WifiContentTransportPlugin.validateAccountBackupUrl(
                        origin + "/api/claims/" + claimId + "/photo", origin, "GET").toString());
        assertEquals(origin + "/api/claims/" + claimId + "/photo",
                WifiContentTransportPlugin.validateAccountBackupUrl(
                        origin + "/api/claims/" + claimId + "/photo", origin, "PUT").toString());

        assertThrows(Exception.class, () -> WifiContentTransportPlugin.validateAccountBackupUrl(
                origin + "/api/claims", origin, "PUT"));
        assertThrows(Exception.class, () -> WifiContentTransportPlugin.validateAccountBackupUrl(
                origin + "/api/claims/" + claimId, origin, "GET"));
        assertThrows(Exception.class, () -> WifiContentTransportPlugin.validateAccountBackupUrl(
                origin + "/api/claims/" + claimId + "/photo/extra", origin, "PUT"));
        assertThrows(Exception.class, () -> WifiContentTransportPlugin.validateAccountBackupUrl(
                origin + "/api/claims/" + claimId + "/photo?download=1", origin, "GET"));
        assertThrows(Exception.class, () -> WifiContentTransportPlugin.validateAccountBackupUrl(
                "https://kip-assets.parkdex.app/releases/photo", origin, "PUT"));
        assertThrows(Exception.class, () -> WifiContentTransportPlugin.validateAccountBackupUrl(
                "https://attacker.example/api/claims", origin, "GET"));
        assertEquals("https://parkdex-kip.vercel.app/api/claims/" + claimId,
                WifiContentTransportPlugin.validateAccountBackupUrl(
                        "https://parkdex-kip.vercel.app/api/claims/" + claimId,
                        "https://parkdex-kip.vercel.app", "PUT").toString());
        if (!BuildConfig.CONTENT_API_HOST.isEmpty()) {
            String previewOrigin = "https://" + BuildConfig.CONTENT_API_HOST;
            assertEquals(previewOrigin + "/api/claims/" + claimId + "/photo",
                    WifiContentTransportPlugin.validateAccountBackupUrl(
                            previewOrigin + "/api/claims/" + claimId + "/photo",
                            previewOrigin, "PUT").toString());
        }
    }

    @Test
    public void boundsAccountRequestBodiesAndRejectsBodiesOnReads() throws Exception {
        String origin = "https://parkdex-kip-staging.vercel.app";
        String claimUrl = origin + "/api/claims/33333333-3333-4333-8333-333333333333";
        String photoUrl = claimUrl + "/photo";
        byte[] claimLimit = new byte[16 * 1024];
        byte[] photoLimit = new byte[2_621_440];
        WifiContentTransportPlugin.validateAccountBackupBody(
                WifiContentTransportPlugin.validateAccountBackupUrl(claimUrl, origin, "PUT"), "PUT", claimLimit);
        WifiContentTransportPlugin.validateAccountBackupBody(
                WifiContentTransportPlugin.validateAccountBackupUrl(photoUrl, origin, "PUT"), "PUT", photoLimit);

        assertThrows(Exception.class, () -> WifiContentTransportPlugin.validateAccountBackupBody(
                WifiContentTransportPlugin.validateAccountBackupUrl(claimUrl, origin, "PUT"), "PUT", new byte[16 * 1024 + 1]));
        assertThrows(Exception.class, () -> WifiContentTransportPlugin.validateAccountBackupBody(
                WifiContentTransportPlugin.validateAccountBackupUrl(photoUrl, origin, "PUT"), "PUT", new byte[2_621_441]));
        assertThrows(Exception.class, () -> WifiContentTransportPlugin.validateAccountBackupBody(
                WifiContentTransportPlugin.validateAccountBackupUrl(photoUrl, origin, "GET"), "GET", new byte[] { 1 }));
        assertThrows(Exception.class, () -> WifiContentTransportPlugin.validateAccountBackupBody(
                WifiContentTransportPlugin.validateAccountBackupUrl(photoUrl, origin, "PUT"), "PUT", new byte[0]));
    }

    @Test
    public void requiresNativeBearerAndAccountScopeWithoutCookies() throws Exception {
        Map<String, String> headers = new HashMap<>();
        headers.put("Authorization", "Bearer native-session-token");
        headers.put("X-Kip-Account-ID", "11111111-1111-4111-8111-111111111111");
        headers.put("X-Kip-Auth-Transport", "native");
        headers.put("Content-Type", "image/jpeg");
        java.net.URL photoUrl = WifiContentTransportPlugin.validateAccountBackupUrl(
                "https://parkdex-kip-staging.vercel.app/api/claims/33333333-3333-4333-8333-333333333333/photo",
                "https://parkdex-kip-staging.vercel.app", "PUT");
        WifiContentTransportPlugin.validateAccountBackupHeaders(headers, photoUrl, "PUT");

        headers.put("Content-Type", "text/plain");
        assertThrows(Exception.class, () -> WifiContentTransportPlugin.validateAccountBackupHeaders(headers, photoUrl, "PUT"));
        headers.put("Content-Type", "image/jpeg");

        headers.put("Cookie", "kip_account=not-forwarded");
        assertThrows(Exception.class, () -> WifiContentTransportPlugin.validateAccountBackupHeaders(headers, photoUrl, "PUT"));
        headers.remove("Cookie");
        headers.remove("Authorization");
        assertThrows(Exception.class, () -> WifiContentTransportPlugin.validateAccountBackupHeaders(headers, photoUrl, "PUT"));
    }

    @Test
    public void writesTheActualAccountPutBodyWithAContentLengthBound() throws Exception {
        byte[] body = new byte[] { 4, 8, 15, 16, 23, 42 };
        RecordingConnection connection = new RecordingConnection(new URL("https://parkdex-kip-staging.vercel.app/api/claims"));

        WifiContentTransportPlugin.writeAccountBackupBody(connection, body);

        assertTrue(connection.outputEnabled);
        assertEquals(body.length, connection.fixedLength);
        assertArrayEquals(body, connection.body.toByteArray());
    }

    private static final class RecordingConnection extends HttpURLConnection {
        final ByteArrayOutputStream body = new ByteArrayOutputStream();
        boolean outputEnabled;
        int fixedLength = -1;

        RecordingConnection(URL url) {
            super(url);
        }

        @Override public void connect() {}
        @Override public void disconnect() {}
        @Override public boolean usingProxy() { return false; }
        @Override public void setDoOutput(boolean value) { outputEnabled = value; }
        @Override public void setFixedLengthStreamingMode(int length) { fixedLength = length; }
        @Override public OutputStream getOutputStream() { return body; }
    }
}
