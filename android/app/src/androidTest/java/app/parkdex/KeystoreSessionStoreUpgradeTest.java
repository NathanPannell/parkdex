package app.parkdex;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Exercises a real v1 Android Keystore envelope through the store's upgrade path. */
@RunWith(AndroidJUnit4.class)
public final class KeystoreSessionStoreUpgradeTest {
    private static final String LEGACY_KEY_ALIAS = "app.parkdex.kip-session.v1";
    private static final String LEGACY_AAD = "app.parkdex.kip-session.v1";
    private static final String API_ORIGIN = "https://staging.web.parkdex.app";
    private static final int LEGACY_MAGIC = 0x4B495031;
    private static final byte[] FIXTURE_TOKEN = "local-upgrade-fixture-token".getBytes(StandardCharsets.UTF_8);

    private Context context;

    @Before
    public void setUp() throws Exception {
        context = ApplicationProvider.getApplicationContext();
        new KeystoreSessionStore(context).clear();
    }

    @After
    public void tearDown() throws Exception {
        new KeystoreSessionStore(context).clear();
    }

    @Test
    public void v1SessionRequiresReauthAcrossReadsUntilNewSessionOrSignOut() throws Exception {
        writeLegacyV1Envelope();

        KeystoreSessionStore.Session firstRead = new KeystoreSessionStore(context).read();
        assertNotNull(firstRead);
        assertTrue(firstRead.requiresReauth);
        assertNull(firstRead.token);

        KeystoreSessionStore.Session afterColdStart = new KeystoreSessionStore(context).read();
        assertNotNull(afterColdStart);
        assertTrue(afterColdStart.requiresReauth);
        assertFalse(new File(new File(context.getFilesDir(), "kip-identity"), "session.enc").exists());

        new KeystoreSessionStore(context).write("new-scoped-session", System.currentTimeMillis() + 60_000, API_ORIGIN);
        KeystoreSessionStore.Session upgraded = new KeystoreSessionStore(context).read();
        assertNotNull(upgraded);
        assertFalse(upgraded.requiresReauth);
        assertEquals("new-scoped-session", upgraded.token);
        assertEquals(API_ORIGIN, upgraded.apiOrigin);

        new KeystoreSessionStore(context).clear();
        assertNull(new KeystoreSessionStore(context).read());
    }

    private void writeLegacyV1Envelope() throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(
                LEGACY_KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        SecretKey key = generator.generateKey();

        ByteArrayOutputStream plaintextBytes = new ByteArrayOutputStream();
        try (DataOutputStream plaintext = new DataOutputStream(plaintextBytes)) {
            plaintext.writeInt(1);
            plaintext.writeLong(System.currentTimeMillis() + 60_000);
            plaintext.writeInt(FIXTURE_TOKEN.length);
            plaintext.write(FIXTURE_TOKEN);
        }

        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        cipher.updateAAD(LEGACY_AAD.getBytes(StandardCharsets.UTF_8));
        byte[] iv = cipher.getIV();
        byte[] ciphertext = cipher.doFinal(plaintextBytes.toByteArray());

        File directory = new File(context.getFilesDir(), "kip-identity");
        assertTrue(directory.exists() || directory.mkdirs());
        File sessionFile = new File(directory, "session.enc");
        try (DataOutputStream output = new DataOutputStream(new FileOutputStream(sessionFile))) {
            output.writeInt(LEGACY_MAGIC);
            output.writeInt(1);
            output.writeInt(iv.length);
            output.write(iv);
            output.writeInt(ciphertext.length);
            output.write(ciphertext);
        }
    }
}
