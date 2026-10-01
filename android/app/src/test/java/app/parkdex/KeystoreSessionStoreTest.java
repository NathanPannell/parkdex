package app.parkdex;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.ByteBuffer;
import org.junit.Test;

public final class KeystoreSessionStoreTest {
    @Test
    public void identifiesTheLegacyEnvelopeHeaderForMigration() {
        byte[] header = ByteBuffer.allocate(8).putInt(0x4B495031).putInt(1).array();
        assertTrue(KeystoreSessionStore.isLegacyFile(header));
        assertFalse(KeystoreSessionStore.isLegacyFile(new byte[] { 0x4B, 0x49, 0x50, 0x32, 0, 0, 0, 2 }));
        assertFalse(KeystoreSessionStore.isLegacyFile(new byte[] { 0x4B, 0x49, 0x50, 0x31 }));
    }

    @Test
    public void acceptsOnlyCanonicalHttpsApiOriginsForPersistedSessions() {
        assertTrue(KeystoreSessionStore.isValidApiOrigin("https://staging.web.parkdex.app"));
        assertFalse(KeystoreSessionStore.isValidApiOrigin("http://staging.web.parkdex.app"));
        assertFalse(KeystoreSessionStore.isValidApiOrigin("https://user@staging.web.parkdex.app"));
        assertFalse(KeystoreSessionStore.isValidApiOrigin("https://staging.web.parkdex.app:444"));
        assertFalse(KeystoreSessionStore.isValidApiOrigin("https://staging.web.parkdex.app/api"));
        assertFalse(KeystoreSessionStore.isValidApiOrigin("https://staging.web.parkdex.app/?token=x"));
    }
}
