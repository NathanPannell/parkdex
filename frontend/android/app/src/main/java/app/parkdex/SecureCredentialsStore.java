package app.parkdex;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.util.Base64;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Properties;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SecureCredentialsStore {
    private static final String KEY_ALIAS = "parkdex.secure.credentials.v1";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final String FILE_NAME = "secure-credentials.properties";
    private static final int KEY_SIZE_BITS = 256;
    private static final int TAG_SIZE_BITS = 128;
    private static final byte FORMAT_VERSION = 1;

    private final AtomicFile credentialFile;

    SecureCredentialsStore(Context context) {
        credentialFile = new AtomicFile(new File(context.getNoBackupFilesDir(), FILE_NAME));
    }

    synchronized String get(String key) throws GeneralSecurityException, IOException {
        Properties values = readValues();
        String encoded = values.getProperty(key);
        if (encoded == null) return null;
        try {
            return decrypt(key, encoded);
        } catch (GeneralSecurityException | IllegalArgumentException invalidValue) {
            values.remove(key);
            writeValues(values);
            return null;
        }
    }

    synchronized void set(String key, String value) throws GeneralSecurityException, IOException {
        Properties values = readValues();
        values.setProperty(key, encrypt(key, value));
        writeValues(values);
    }

    synchronized void remove(String key) throws IOException {
        Properties values = readValues();
        if (values.remove(key) != null) writeValues(values);
    }

    private SecretKey getOrCreateKey() throws GeneralSecurityException, IOException {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        java.security.Key existing = keyStore.getKey(KEY_ALIAS, null);
        if (existing instanceof SecretKey) return (SecretKey) existing;

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(KEY_SIZE_BITS)
            .build());
        return generator.generateKey();
    }

    private String encrypt(String key, String value) throws GeneralSecurityException, IOException {
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
        byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] iv = cipher.getIV();
        ByteBuffer payload = ByteBuffer.allocate(2 + iv.length + ciphertext.length);
        payload.put(FORMAT_VERSION).put((byte) iv.length).put(iv).put(ciphertext);
        return Base64.encodeToString(payload.array(), Base64.NO_WRAP);
    }

    private String decrypt(String key, String encoded) throws GeneralSecurityException, IOException {
        byte[] payload = Base64.decode(encoded, Base64.NO_WRAP);
        ByteBuffer buffer = ByteBuffer.wrap(payload);
        if (buffer.remaining() < 3 || buffer.get() != FORMAT_VERSION) {
            throw new GeneralSecurityException("Unsupported secure credential format");
        }
        int ivLength = buffer.get() & 0xff;
        if (ivLength < 12 || buffer.remaining() <= ivLength) {
            throw new GeneralSecurityException("Invalid secure credential payload");
        }
        byte[] iv = new byte[ivLength];
        byte[] ciphertext = new byte[buffer.remaining() - ivLength];
        buffer.get(iv).get(ciphertext);
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(TAG_SIZE_BITS, iv));
        cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
        return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
    }

    private Properties readValues() throws IOException {
        Properties values = new Properties();
        try (FileInputStream input = credentialFile.openRead()) {
            values.load(input);
        } catch (FileNotFoundException missing) {
            return values;
        }
        return values;
    }

    private void writeValues(Properties values) throws IOException {
        FileOutputStream output = null;
        try {
            output = credentialFile.startWrite();
            values.store(output, null);
            credentialFile.finishWrite(output);
        } catch (IOException error) {
            if (output != null) credentialFile.failWrite(output);
            throw error;
        }
    }

    File fileForTests() {
        return credentialFile.getBaseFile();
    }
}
