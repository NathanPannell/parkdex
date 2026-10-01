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
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.Locale;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Stores the Kip bearer session as authenticated ciphertext under a device Keystore key. */
final class KeystoreSessionStore {
    private static final String KEY_ALIAS = "app.parkdex.kip-session.v2";
    private static final String LEGACY_KEY_ALIAS = "app.parkdex.kip-session.v1";
    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String DIRECTORY_NAME = "kip-identity";
    private static final String FILE_NAME = "session.enc";
    private static final String REAUTH_FILE_NAME = "session.reauth";
    private static final String AAD = "app.parkdex.kip-session.v2";
    private static final int FILE_MAGIC = 0x4B495032;
    private static final int LEGACY_FILE_MAGIC = 0x4B495031;
    private static final int FORMAT_VERSION = 2;
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;
    private static final int MAX_TOKEN_BYTES = 4096;
    private static final int MAX_API_ORIGIN_BYTES = 512;
    private static final int MAX_FILE_BYTES = 16 * 1024;

    private final Context context;

    KeystoreSessionStore(Context context) {
        this.context = context.getApplicationContext();
    }

    synchronized void write(String token, long expiresAt, String apiOrigin) throws IOException, GeneralSecurityException {
        if (token == null || token.isEmpty() || token.getBytes(StandardCharsets.UTF_8).length > MAX_TOKEN_BYTES) {
            throw new IllegalArgumentException("Invalid session token.");
        }
        if (!isValidApiOrigin(apiOrigin)) throw new IllegalArgumentException("Invalid account API origin.");
        if (expiresAt <= System.currentTimeMillis()) {
            throw new IllegalArgumentException("Session expiry must be in the future.");
        }

        byte[] plaintext = encodeSession(token, expiresAt, apiOrigin);
        try {
            try {
                writeEncrypted(plaintext);
            } catch (GeneralSecurityException staleKey) {
                // A restored, invalidated, or otherwise lost Keystore key cannot decrypt the old
                // file. Remove both halves before retrying with a new device-bound key.
                try {
                    clearSessionMaterial();
                    writeEncrypted(plaintext);
                } catch (IOException | GeneralSecurityException recoveryFailure) {
                    recoveryFailure.addSuppressed(staleKey);
                    throw recoveryFailure;
                }
            }
            clearReauthenticationMarkerQuietly();
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
            AtomicFile atomicFile = getAtomicFile(FILE_NAME, true);
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
        AtomicFile atomicFile = getAtomicFile(FILE_NAME, false);
        byte[] encodedFile;
        try (FileInputStream input = atomicFile.openRead()) {
            encodedFile = readBounded(input);
        } catch (java.io.FileNotFoundException missing) {
            return hasReauthenticationMarker() ? Session.reauthenticationRequired() : null;
        } catch (IOException unreadable) {
            markReauthenticationRequiredQuietly();
            return Session.reauthenticationRequired();
        }

        byte[] plaintext = null;
        try {
            if (isLegacyFile(encodedFile)) {
                markReauthenticationRequiredQuietly();
                return Session.reauthenticationRequired();
            }
            EncryptedFile file = decodeEncryptedFile(encodedFile);
            SecretKey key = loadExistingKey();
            if (key == null) {
                markReauthenticationRequiredQuietly();
                return Session.reauthenticationRequired();
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, file.iv));
            cipher.updateAAD(AAD.getBytes(StandardCharsets.UTF_8));
            plaintext = cipher.doFinal(file.ciphertext);
            Session session = decodeSession(plaintext);
            if (session.expiresAt <= System.currentTimeMillis()) {
                markReauthenticationRequiredQuietly();
                return Session.reauthenticationRequired();
            }
            return session;
        } catch (GeneralSecurityException | RuntimeException | IOException invalid) {
            // Persist reauthentication before removing an unusable bearer so local account data
            // remains visible across process restarts.
            markReauthenticationRequiredQuietly();
            return Session.reauthenticationRequired();
        } finally {
            Arrays.fill(encodedFile, (byte) 0);
            if (plaintext != null) Arrays.fill(plaintext, (byte) 0);
        }
    }

    synchronized void clear() throws IOException, GeneralSecurityException {
        try {
            clearSessionMaterial();
        } finally {
            getAtomicFile(REAUTH_FILE_NAME, false).delete();
        }
    }

    private void clearSessionMaterial() throws IOException, GeneralSecurityException {
        getAtomicFile(FILE_NAME, false).delete();
        KeyStore keyStore = loadKeyStore();
        if (keyStore.containsAlias(KEY_ALIAS)) keyStore.deleteEntry(KEY_ALIAS);
        if (keyStore.containsAlias(LEGACY_KEY_ALIAS)) keyStore.deleteEntry(LEGACY_KEY_ALIAS);
    }

    private AtomicFile getAtomicFile(String fileName, boolean createDirectory) throws IOException {
        File directory = new File(context.getFilesDir(), DIRECTORY_NAME);
        if (createDirectory && !directory.exists() && !directory.mkdirs() && !directory.isDirectory()) {
            throw new IOException("Unable to create secure session directory.");
        }
        return new AtomicFile(new File(directory, fileName));
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

    private byte[] encodeSession(String token, long expiresAt, String apiOrigin) throws IOException {
        byte[] tokenBytes = token.getBytes(StandardCharsets.UTF_8);
        byte[] originBytes = apiOrigin.getBytes(StandardCharsets.UTF_8);
        try {
            java.nio.ByteBuffer buffer = java.nio.ByteBuffer.allocate(20 + originBytes.length + tokenBytes.length);
            buffer.putInt(FORMAT_VERSION);
            buffer.putLong(expiresAt);
            buffer.putInt(originBytes.length);
            buffer.putInt(tokenBytes.length);
            buffer.put(originBytes);
            buffer.put(tokenBytes);
            return buffer.array();
        } finally {
            Arrays.fill(tokenBytes, (byte) 0);
            Arrays.fill(originBytes, (byte) 0);
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
            int originLength = input.readInt();
            int tokenLength = input.readInt();
            if (originLength < 1 || originLength > MAX_API_ORIGIN_BYTES || tokenLength < 1 || tokenLength > MAX_TOKEN_BYTES
                    || originLength + tokenLength != input.available()) {
                throw new IOException("Invalid session payload.");
            }
            byte[] originBytes = new byte[originLength];
            byte[] tokenBytes = new byte[tokenLength];
            input.readFully(originBytes);
            input.readFully(tokenBytes);
            try {
                String apiOrigin = new String(originBytes, StandardCharsets.UTF_8);
                if (!isValidApiOrigin(apiOrigin)) throw new IOException("Invalid account API origin.");
                String token = new String(tokenBytes, StandardCharsets.UTF_8);
                if (token.trim().isEmpty()) throw new IOException("Invalid session token.");
                return new Session(token, expiresAt, apiOrigin);
            } finally {
                Arrays.fill(originBytes, (byte) 0);
                Arrays.fill(tokenBytes, (byte) 0);
            }
        }
    }

    static boolean isLegacyFile(byte[] bytes) {
        if (bytes.length < 8) return false;
        java.nio.ByteBuffer header = java.nio.ByteBuffer.wrap(bytes, 0, 8);
        return header.getInt() == LEGACY_FILE_MAGIC && header.getInt() == 1;
    }

    static boolean isValidApiOrigin(String value) {
        if (value == null || value.isEmpty() || value.getBytes(StandardCharsets.UTF_8).length > MAX_API_ORIGIN_BYTES) return false;
        try {
            URI uri = new URI(value);
            String host = uri.getHost();
            return "https".equals(uri.getScheme()) && host != null && uri.getRawUserInfo() == null && uri.getPort() == -1
                    && (uri.getRawPath() == null || uri.getRawPath().isEmpty()) && uri.getRawQuery() == null
                    && uri.getRawFragment() == null && value.equals("https://" + host.toLowerCase(Locale.ROOT));
        } catch (URISyntaxException | IllegalArgumentException invalid) {
            return false;
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

    private boolean hasReauthenticationMarker() {
        try (FileInputStream input = getAtomicFile(REAUTH_FILE_NAME, false).openRead()) {
            return input.read() == 1 && input.read() == -1;
        } catch (java.io.FileNotFoundException missing) {
            return false;
        } catch (IOException unreadable) {
            return false;
        }
    }

    private void markReauthenticationRequiredQuietly() {
        try {
            AtomicFile marker = getAtomicFile(REAUTH_FILE_NAME, true);
            FileOutputStream output = null;
            try {
                output = marker.startWrite();
                output.write(1);
                output.flush();
                output.getFD().sync();
                marker.finishWrite(output);
                output = null;
            } finally {
                if (output != null) marker.failWrite(output);
            }
            clearSessionMaterial();
        } catch (IOException | GeneralSecurityException ignored) {
            // Keep the envelope for another attempt if the marker cannot be made durable.
        }
    }

    private void clearReauthenticationMarkerQuietly() {
        try {
            getAtomicFile(REAUTH_FILE_NAME, false).delete();
        } catch (IOException ignored) {
            // A valid scoped session takes precedence over a stale marker.
        }
    }

    static final class Session {
        final String token;
        final long expiresAt;
        final String apiOrigin;
        final boolean requiresReauth;

        Session(String token, long expiresAt, String apiOrigin) {
            this.token = token;
            this.expiresAt = expiresAt;
            this.apiOrigin = apiOrigin;
            this.requiresReauth = false;
        }

        private Session() {
            this.token = null;
            this.expiresAt = 0;
            this.apiOrigin = null;
            this.requiresReauth = true;
        }

        static Session reauthenticationRequired() {
            return new Session();
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
