package app.parkdex;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import android.content.Context;

import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Properties;

public class SecureCredentialsStoreInstrumentedTest {
    private static final String TOKEN_KEY = "every-park:account-token:v1";
    private SecureCredentialsStore store;

    @Before
    public void setUp() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        store = new SecureCredentialsStore(context);
        store.remove(TOKEN_KEY);
    }

    @After
    public void tearDown() throws Exception {
        store.remove(TOKEN_KEY);
    }

    @Test
    public void persistsEncryptedCredentialAcrossStoreInstances() throws Exception {
        store.set(TOKEN_KEY, "raw-bearer-token");

        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        SecureCredentialsStore restartedStore = new SecureCredentialsStore(context);

        assertEquals("raw-bearer-token", restartedStore.get(TOKEN_KEY));
        byte[] bytes = new byte[(int) store.fileForTests().length()];
        try (FileInputStream input = new FileInputStream(store.fileForTests())) {
            org.junit.Assert.assertEquals(bytes.length, input.read(bytes));
        }
        String diskValue = new String(bytes, StandardCharsets.ISO_8859_1);
        org.junit.Assert.assertFalse(diskValue.contains("raw-bearer-token"));
    }

    @Test
    public void removesCredential() throws Exception {
        store.set(TOKEN_KEY, "raw-bearer-token");
        store.remove(TOKEN_KEY);
        assertNull(store.get(TOKEN_KEY));
    }

    @Test
    public void clearsCorruptCiphertext() throws Exception {
        Properties values = new Properties();
        values.setProperty(TOKEN_KEY, "not-valid-ciphertext");
        try (FileOutputStream output = new FileOutputStream(store.fileForTests())) {
            values.store(output, null);
        }

        assertNull(store.get(TOKEN_KEY));
        assertNull(store.get(TOKEN_KEY));
    }
}
