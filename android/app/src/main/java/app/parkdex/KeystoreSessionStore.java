package app.parkdex;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Stores the Kip bearer session as authenticated ciphertext under a device Keystore key. */
final class KeystoreSessionStore {
    private static final String KEY_ALIAS = "app.parkdex.kip-session.v1";
    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String DIRECTORY_NAME = "kip-identity";
    private static final String FILE_NAME = "session.enc";
    private static final String AAD = "app.parkdex.kip-session.v1";
    private static final int FILE_MAGIC = 0x4B495031;
    private static final int FORMAT_VERSION = 1;
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;
    private static final int MAX_TOKEN_BYTES = 4096;
    private static final int MAX_FILE_BYTES = 16 * 1024;

    private final Context context;

    KeystoreSessionStore(Context context) {
        this.context = context.getApplicationContext();
    }

    synchronized void write(String token, long expiresAt) throws IOException, GeneralSecurityException {
        if (token == null || token.isEmpty() || token.getBytes(StandardCharsets.UTF_8).length > MAX_TOKEN_BYTES) {
            throw new IllegalArgumentException("Invalid session token.");
        }
        if (expiresAt <= System.currentTimeMillis()) {
            throw new IllegalArgumentException("Session expiry must be in the future.");
        }

        byte[] plaintext = encodeSession(token, expiresAt);
        try {
            try {
                writeEncrypted(plaintext);
            } catch (GeneralSecurityException staleKey) {
                // A restored, invalidated, or otherwise lost Keystore key cannot decrypt the old
                // file. Remove both halves before retrying with a new device-bound key.
                try {
                    clear();
                    writeEncrypted(plaintext);
                } catch (IOException | GeneralSecurityException recoveryFailure) {
                    recoveryFailure.addSuppressed(staleKey);
                    throw recoveryFailure;
                }
            }
        } finally {
            Arrays.fill(plaintext, (byte) 0);
        }
    }

    private void writeEncrypted(byte[] plaintext) throws IOException, GeneralSecurityException {
        byte[] encodedFile = null;
        byte[] encrypted = null;
        try {
            SecretKey key = loadOrCreateKey();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            cipher.updateAAD(AAD.getBytes(StandardCharsets.UTF_8));
            byte[] iv = cipher.getIV();
            if (iv == null || iv.length != IV_BYTES) throw new GeneralSecurityException("Unexpected session IV.");
            encrypted = cipher.doFinal(plaintext);
            encodedFile = encodeEncryptedFile(iv, encrypted);
            AtomicFile atomicFile = getAtomicFile(true);
            FileOutputStream output = null;
            try {
                output = atomicFile.startWrite();
                output.write(encodedFile);
                output.flush();
                output.getFD().sync();
                atomicFile.finishWrite(output);
                output = null;
            } finally {
                if (output != null) atomicFile.failWrite(output);
            }
        } finally {
            if (encodedFile != null) Arrays.fill(encodedFile, (byte) 0);
            if (encrypted != null) Arrays.fill(encrypted, (byte) 0);
        }
    }

    synchronized Session read() throws IOException {
        AtomicFile atomicFile = getAtomicFile(false);
        byte[] encodedFile;
        try (FileInputStream input = atomicFile.openRead()) {
            encodedFile = readBounded(input);
        } catch (java.io.FileNotFoundException missing) {
            return null;
        } catch (IOException unreadable) {
            clearQuietly();
            return null;
        }

        byte[] plaintext = null;
        try {
            EncryptedFile file = decodeEncryptedFile(encodedFile);
            SecretKey key = loadExistingKey();
            if (key == null) {
                clearQuietly();
                return null;
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, file.iv));
            cipher.updateAAD(AAD.getBytes(StandardCharsets.UTF_8));
            plaintext = cipher.doFinal(file.ciphertext);
            Session session = decodeSession(plaintext);
            if (session.expiresAt <= System.currentTimeMillis()) {
                clearQuietly();
                return null;
            }
            return session;
        } catch (GeneralSecurityException | RuntimeException | IOException invalid) {
            // A missing or invalidated Keystore key makes the ciphertext unusable. Treat that
            // condition as a logged-out session and remove both halves of the stored credential.
            clearQuietly();
            return null;
        } finally {
            Arrays.fill(encodedFile, (byte) 0);
            if (plaintext != null) Arrays.fill(plaintext, (byte) 0);
        }
    }

    synchronized void clear() throws IOException, GeneralSecurityException {
        getAtomicFile(false).delete();
        KeyStore keyStore = loadKeyStore();
        if (keyStore.containsAlias(KEY_ALIAS)) keyStore.deleteEntry(KEY_ALIAS);
    }

    private AtomicFile getAtomicFile(boolean createDirectory) throws IOException {
        File directory = new File(context.getFilesDir(), DIRECTORY_NAME);
        if (createDirectory && !directory.exists() && !directory.mkdirs() && !directory.isDirectory()) {
            throw new IOException("Unable to create secure session directory.");
        }
        return new AtomicFile(new File(directory, FILE_NAME));
    }

    private SecretKey loadExistingKey() throws GeneralSecurityException, IOException {
        KeyStore keyStore = loadKeyStore();
        if (!keyStore.containsAlias(KEY_ALIAS)) return null;
        java.security.Key key = keyStore.getKey(KEY_ALIAS, null);
        return key instanceof SecretKey ? (SecretKey) key : null;
    }

    private SecretKey loadOrCreateKey() throws GeneralSecurityException, IOException {
        SecretKey existing = loadExistingKey();
        if (existing != null) return existing;

        KeyStore keyStore = loadKeyStore();
        if (keyStore.containsAlias(KEY_ALIAS)) keyStore.deleteEntry(KEY_ALIAS);

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER);
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }

    private KeyStore loadKeyStore() throws GeneralSecurityException, IOException {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
        keyStore.load(null);
        return keyStore;
    }

    private byte[] encodeSession(String token, long expiresAt) throws IOException {
        byte[] tokenBytes = token.getBytes(StandardCharsets.UTF_8);
        try {
            java.nio.ByteBuffer buffer = java.nio.ByteBuffer.allocate(16 + tokenBytes.length);
            buffer.putInt(FORMAT_VERSION);
            buffer.putLong(expiresAt);
            buffer.putInt(tokenBytes.length);
            buffer.put(tokenBytes);
            return buffer.array();
        } finally {
            Arrays.fill(tokenBytes, (byte) 0);
        }
    }

    private EncryptedFile decodeEncryptedFile(byte[] bytes) throws IOException {
        if (bytes.length == 0 || bytes.length > MAX_FILE_BYTES) throw new IOException("Invalid session file size.");
        try (DataInputStream input = new DataInputStream(new ByteArrayInputStream(bytes))) {
            if (input.readInt() != FILE_MAGIC || input.readInt() != FORMAT_VERSION) {
                throw new IOException("Unsupported session file format.");
            }
            int ivLength = input.readInt();
            if (ivLength != IV_BYTES) throw new IOException("Invalid session IV.");
            byte[] iv = new byte[ivLength];
            input.readFully(iv);
            int ciphertextLength = input.readInt();
            if (ciphertextLength < 16 || ciphertextLength > MAX_FILE_BYTES || ciphertextLength != input.available()) {
                throw new IOException("Invalid session ciphertext.");
            }
            byte[] ciphertext = new byte[ciphertextLength];
            input.readFully(ciphertext);
            return new EncryptedFile(iv, ciphertext);
        }
    }

    private byte[] encodeEncryptedFile(byte[] iv, byte[] ciphertext) throws IOException {
        if (iv == null || iv.length != IV_BYTES || ciphertext == null || ciphertext.length > MAX_FILE_BYTES) {
            throw new IOException("Invalid encrypted session data.");
        }
        try (ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                DataOutputStream output = new DataOutputStream(bytes)) {
            output.writeInt(FILE_MAGIC);
            output.writeInt(FORMAT_VERSION);
            output.writeInt(iv.length);
            output.write(iv);
            output.writeInt(ciphertext.length);
            output.write(ciphertext);
            output.flush();
            return bytes.toByteArray();
        }
    }

    private Session decodeSession(byte[] plaintext) throws IOException {
        try (DataInputStream input = new DataInputStream(new ByteArrayInputStream(plaintext))) {
            if (input.readInt() != FORMAT_VERSION) throw new IOException("Unsupported session payload.");
            long expiresAt = input.readLong();
            int tokenLength = input.readInt();
            if (tokenLength < 1 || tokenLength > MAX_TOKEN_BYTES || tokenLength != input.available()) {
                throw new IOException("Invalid session payload.");
            }
            byte[] tokenBytes = new byte[tokenLength];
            input.readFully(tokenBytes);
            try {
                String token = new String(tokenBytes, StandardCharsets.UTF_8);
                if (token.trim().isEmpty()) throw new IOException("Invalid session token.");
                return new Session(token, expiresAt);
            } finally {
                Arrays.fill(tokenBytes, (byte) 0);
            }
        }
    }

    private byte[] readBounded(FileInputStream input) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[1024];
        int total = 0;
        int read;
        while ((read = input.read(buffer)) != -1) {
            total += read;
            if (total > MAX_FILE_BYTES) throw new IOException("Session file is too large.");
            bytes.write(buffer, 0, read);
        }
        Arrays.fill(buffer, (byte) 0);
        return bytes.toByteArray();
    }

    private void clearQuietly() {
        try {
            clear();
        } catch (IOException | GeneralSecurityException ignored) {
            // There is no safe session to return even if cleanup itself is temporarily unavailable.
        }
    }

    static final class Session {
        final String token;
        final long expiresAt;

        Session(String token, long expiresAt) {
            this.token = token;
            this.expiresAt = expiresAt;
        }
    }

    private static final class EncryptedFile {
        final byte[] iv;
        final byte[] ciphertext;

        EncryptedFile(byte[] iv, byte[] ciphertext) {
            this.iv = iv;
            this.ciphertext = ciphertext;
        }
    }
}
