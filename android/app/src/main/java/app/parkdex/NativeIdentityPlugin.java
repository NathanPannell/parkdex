package app.parkdex;

import android.app.Activity;
import android.content.MutableContextWrapper;
import android.os.CancellationSignal;
import androidx.credentials.ClearCredentialStateRequest;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.ClearCredentialException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import java.io.IOException;
import java.security.GeneralSecurityException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "NativeIdentity")
public final class NativeIdentityPlugin extends Plugin {
    private static final ExecutorService STORAGE_EXECUTOR = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void getGoogleIdToken(PluginCall call) {
        String serverClientId = normalized(call.getString("serverClientId"));
        String nonce = call.getString("nonce");
        if (serverClientId == null || nonce == null || nonce.isEmpty() || !nonce.equals(nonce.trim())
                || serverClientId.length() > 512 || nonce.length() > 512) {
            call.reject("Google sign-in is not configured for this request.");
            return;
        }

        Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) {
            call.reject("Google sign-in is unavailable right now.");
            return;
        }

        activity.runOnUiThread(() -> {
            try {
                GetSignInWithGoogleOption googleOption = new GetSignInWithGoogleOption.Builder(serverClientId)
                        .setNonce(nonce)
                        .build();
                GetCredentialRequest request = new GetCredentialRequest.Builder()
                        .addCredentialOption(googleOption)
                        .build();
                CredentialManager credentialManager = CredentialManager.create(activity);
                credentialManager.getCredentialAsync(
                        new MutableContextWrapper(activity),
                        request,
                        new CancellationSignal(),
                        ContextCompat.getMainExecutor(activity),
                        new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                            @Override
                            public void onResult(GetCredentialResponse response) {
                                handleGoogleCredential(call, response);
                            }

                            @Override
                            public void onError(GetCredentialException error) {
                                // Provider exception text can contain user-specific data. Never return or log it.
                                call.reject("Google sign-in was canceled or could not be completed.");
                            }
                        });
            } catch (RuntimeException error) {
                call.reject("Google sign-in is unavailable right now.");
            }
        });
    }

    @PluginMethod
    public void setSession(PluginCall call) {
        String token = call.getString("token");
        Object rawExpiry = call.getData().opt("expiresAt");
        if (token == null || token.isEmpty() || !token.equals(token.trim()) || token.length() > 4096
                || !(rawExpiry instanceof Number)) {
            call.reject("A valid native session is required.");
            return;
        }
        long expiresAt = ((Number) rawExpiry).longValue();
        if (expiresAt <= System.currentTimeMillis()) {
            call.reject("The native session has expired.");
            return;
        }

        STORAGE_EXECUTOR.execute(() -> {
            try {
                new KeystoreSessionStore(getContext()).write(token, expiresAt);
                call.resolve();
            } catch (IOException | GeneralSecurityException | RuntimeException error) {
                call.reject("Unable to securely save the native session.");
            }
        });
    }

    @PluginMethod
    public void getSession(PluginCall call) {
        STORAGE_EXECUTOR.execute(() -> {
            try {
                KeystoreSessionStore.Session session = new KeystoreSessionStore(getContext()).read();
                if (session == null) {
                    call.resolve();
                    return;
                }
                JSObject result = new JSObject();
                result.put("token", session.token);
                result.put("expiresAt", session.expiresAt);
                call.resolve(result);
            } catch (IOException | RuntimeException error) {
                call.reject("Unable to read the secure native session.");
            }
        });
    }

    @PluginMethod
    public void clearSession(PluginCall call) {
        STORAGE_EXECUTOR.execute(() -> {
            try {
                new KeystoreSessionStore(getContext()).clear();
            } catch (IOException | GeneralSecurityException | RuntimeException error) {
                call.reject("Unable to clear the secure native session.");
                return;
            }

            Activity activity = getActivity();
            if (activity == null || activity.isFinishing()) {
                call.resolve();
                return;
            }
            activity.runOnUiThread(() -> clearCredentialProviderState(activity, call));
        });
    }

    private void handleGoogleCredential(PluginCall call, GetCredentialResponse response) {
        Credential credential = response.getCredential();
        if (!(credential instanceof CustomCredential)
                || !GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) {
            call.reject("Google sign-in returned an unsupported credential.");
            return;
        }
        try {
            GoogleIdTokenCredential googleCredential = GoogleIdTokenCredential.createFrom(
                    ((CustomCredential) credential).getData());
            String idToken = normalized(googleCredential.getIdToken());
            if (idToken == null) {
                call.reject("Google sign-in did not return an ID token.");
                return;
            }
            JSObject result = new JSObject();
            result.put("idToken", idToken);
            call.resolve(result);
        } catch (RuntimeException error) {
            call.reject("Google sign-in returned an invalid credential.");
        }
    }

    private void clearCredentialProviderState(Activity activity, PluginCall call) {
        try {
            CredentialManager.create(activity).clearCredentialStateAsync(
                    new ClearCredentialStateRequest(),
                    new CancellationSignal(),
                    ContextCompat.getMainExecutor(activity),
                    new CredentialManagerCallback<Void, ClearCredentialException>() {
                        @Override
                        public void onResult(Void result) {
                            call.resolve();
                        }

                        @Override
                        public void onError(ClearCredentialException error) {
                            // The app session is already deleted; provider cleanup can fail independently.
                            call.resolve();
                        }
                    });
        } catch (RuntimeException error) {
            call.resolve();
        }
    }

    private static String normalized(String value) {
        if (value == null) return null;
        String result = value.trim();
        return result.isEmpty() ? null : result;
    }
}
