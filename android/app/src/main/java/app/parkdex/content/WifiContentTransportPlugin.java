package app.parkdex.content;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import app.parkdex.BuildConfig;

import org.json.JSONException;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.net.URLConnection;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "WifiContentTransport")
public class WifiContentTransportPlugin extends Plugin {
    private static final int DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
    private static final int HARD_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
    private static final int MAX_ACCOUNT_BACKUP_BYTES = 2_621_440;
    private static final int MAX_CLAIM_JSON_BYTES = 16 * 1024;
    private static final int DEFAULT_TIMEOUT_MS = 20_000;
    private static final int NETWORK_WAIT_TIMEOUT_MS = 15_000;
    private static final int MAX_TIMEOUT_MS = 60_000;
    private static final int READ_BUFFER_BYTES = 16 * 1024;
    private static final java.util.regex.Pattern WIFI_ONLY_MAP_CHUNK_PATH = java.util.regex.Pattern.compile(
            "(?i)(?:^|/)map/island/[^/]+\\.bin$");
    private static final Set<String> BLOCKED_HEADERS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "host", "connection", "content-length", "transfer-encoding", "upgrade",
            "keep-alive", "proxy-authorization", "proxy-authenticate", "cookie", "set-cookie", "accept-encoding"
    )));
    private static final ExecutorService REQUEST_EXECUTOR = Executors.newCachedThreadPool();
    private static final ScheduledExecutorService NETWORK_TIMEOUT_EXECUTOR = Executors.newSingleThreadScheduledExecutor();

    private final Map<String, ActiveRequest> activeRequests = new ConcurrentHashMap<>();
    private final Object lifecycleLock = new Object();
    // Requests run only while the Activity is started, so never in the background. A pause alone,
    // such as a permission dialog over Parkdex, keeps them running: the web layer's appStateChange
    // also treats only a stop as leaving the foreground.
    private volatile boolean stopped;
    private volatile boolean destroyed;

    private static final String APPROVED_CDN_ORIGIN = "https://kip-assets.parkdex.app";

    @Override
    protected void handleOnStart() {
        synchronized (lifecycleLock) {
            if (!destroyed) stopped = false;
        }
        super.handleOnStart();
    }

    @Override
    protected void handleOnResume() {
        synchronized (lifecycleLock) {
            if (!destroyed) stopped = false;
        }
        super.handleOnResume();
    }

    @Override
    protected void handleOnStop() {
        synchronized (lifecycleLock) {
            stopped = true;
        }
        failActiveRequests("Content requests stop when Parkdex leaves the foreground");
        super.handleOnStop();
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (lifecycleLock) {
            destroyed = true;
            stopped = true;
        }
        failActiveRequests("Content requests stop when Parkdex closes");
        super.handleOnDestroy();
    }

    @PluginMethod
    public void getWifiStatus(PluginCall call) {
        ConnectivityManager manager = connectivityManager();
        boolean available = false;
        if (manager != null) {
            try {
                Network[] networks = manager.getAllNetworks();
                for (Network network : networks) {
                    NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
                    if (isUsableWifi(capabilities)) {
                        available = true;
                        break;
                    }
                }
            } catch (SecurityException ignored) {
                available = false;
            }
        }
        JSObject result = new JSObject();
        result.put("wifi", available);
        call.resolve(result);
    }

    @PluginMethod
    public void request(PluginCall call) {
        String requestId = call.getString("requestId");
        String urlText = call.getString("url");
        String method = call.getString("method", "GET");
        int maxResponseBytes = call.getInt("maxResponseBytes", DEFAULT_MAX_RESPONSE_BYTES);
        int timeoutMs = call.getInt("timeoutMs", DEFAULT_TIMEOUT_MS);
        // Nearby and streamed map detail may use mobile data; other map chunks stay on Wi-Fi.
        boolean anyNetwork = Boolean.TRUE.equals(call.getBoolean("anyNetwork", false));

        if (requestId == null || requestId.isEmpty() || requestId.length() > 128) {
            call.reject("A valid requestId is required");
            return;
        }
        if (urlText == null) {
            call.reject("A content URL is required");
            return;
        }
        if (!"GET".equals(method) && !"HEAD".equals(method)) {
            call.reject("Content transport only permits GET and HEAD requests");
            return;
        }
        if (maxResponseBytes < 1 || maxResponseBytes > HARD_MAX_RESPONSE_BYTES) {
            call.reject("The content response byte limit is invalid");
            return;
        }
        if (timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
            call.reject("The content request timeout is invalid");
            return;
        }

        final URL url;
        try {
            url = validateContentUrl(urlText, call.getString("approvedApiOrigin"), call.getString("approvedCdnOrigin"));
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "The content URL is not approved" : error.getMessage());
            return;
        }

        ConnectivityManager manager = connectivityManager();
        if (manager == null) {
            call.reject("Network connectivity is unavailable");
            return;
        }

        ActiveRequest state;
        synchronized (lifecycleLock) {
            if (!acceptsRequests()) {
                call.reject("Content requests require Parkdex to be in the foreground");
                return;
            }
            state = new ActiveRequest(requestId, call, manager, url, method,
                    call.getObject("headers"), maxResponseBytes, timeoutMs, anyNetwork);
            ActiveRequest existing = activeRequests.putIfAbsent(requestId, state);
            if (existing != null) {
                call.reject("A content request already uses this requestId");
                return;
            }
        }

        startNetworkRequest(state);
    }

    @PluginMethod
    public void accountRequest(PluginCall call) {
        String requestId = call.getString("requestId");
        String urlText = call.getString("url");
        String method = call.getString("method", "GET");
        String bodyBase64 = call.getString("bodyBase64", "");
        int maxRequestBytes = call.getInt("maxRequestBytes", MAX_ACCOUNT_BACKUP_BYTES);
        int maxResponseBytes = call.getInt("maxResponseBytes", MAX_ACCOUNT_BACKUP_BYTES);
        int timeoutMs = call.getInt("timeoutMs", DEFAULT_TIMEOUT_MS);

        if (requestId == null || requestId.isEmpty() || requestId.length() > 128) {
            call.reject("A valid requestId is required");
            return;
        }
        if (urlText == null) {
            call.reject("An account backup URL is required");
            return;
        }
        if (bodyBase64.length() > ((MAX_ACCOUNT_BACKUP_BYTES + 2) / 3) * 4 + 4) {
            call.reject("The account backup request exceeds its byte limit");
            return;
        }
        final byte[] body;
        try {
            body = bodyBase64.isEmpty() ? new byte[0] : Base64.decode(bodyBase64, Base64.DEFAULT);
        } catch (IllegalArgumentException error) {
            call.reject("The account backup request body is invalid");
            return;
        }

        final URL url;
        try {
            url = validateAccountBackupUrl(urlText, call.getString("approvedApiOrigin"), method);
            validateAccountBackupBody(url, method, body);
            validateAccountBackupHeaders(accountHeaders(call.getObject("headers")), url, method);
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "The account backup request is not approved" : error.getMessage());
            return;
        }
        int routeRequestLimit = url.getPath().matches("(?i)^/api/claims/[0-9a-f-]{36}$")
                ? MAX_CLAIM_JSON_BYTES : MAX_ACCOUNT_BACKUP_BYTES;
        if (maxRequestBytes < 1 || maxRequestBytes > routeRequestLimit || body.length > maxRequestBytes) {
            call.reject("The account backup request byte limit is invalid");
            return;
        }
        if (maxResponseBytes < 1 || maxResponseBytes > MAX_ACCOUNT_BACKUP_BYTES) {
            call.reject("The account backup response byte limit is invalid");
            return;
        }
        if (timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
            call.reject("The account backup request timeout is invalid");
            return;
        }

        ConnectivityManager manager = connectivityManager();
        if (manager == null) {
            call.reject("Network connectivity is unavailable");
            return;
        }

        ActiveRequest state;
        synchronized (lifecycleLock) {
            if (!acceptsRequests()) {
                call.reject("Account backup requests require Parkdex to be in the foreground");
                return;
            }
            state = new ActiveRequest(requestId, call, manager, url, method,
                    call.getObject("headers"), maxResponseBytes, timeoutMs, true, body);
            ActiveRequest existing = activeRequests.putIfAbsent(requestId, state);
            if (existing != null) {
                call.reject("A request already uses this requestId");
                return;
            }
        }
        startNetworkRequest(state);
    }

    private void startNetworkRequest(ActiveRequest state) {
        if (state.wifiRequired) startWifiRequest(state);
        else startAnyValidatedNetworkRequest(state);
    }

    private void startWifiRequest(ActiveRequest state) {
        NetworkRequest wifiRequest = new NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build();
        state.networkCallback = createNetworkCallback(state, true);
        state.scheduleNetworkWaitTimeout();

        try {
            state.registerNetwork(wifiRequest);
            Network[] networks = state.manager.getAllNetworks();
            for (Network network : networks) {
                if (state.isFinished() || state.selectedNetwork != null) break;
                acceptNetworkIfUsable(state, network, state.manager.getNetworkCapabilities(network), true);
            }
        } catch (RuntimeException error) {
            state.fail("Wi-Fi networking is unavailable");
        }
    }

    private void startAnyValidatedNetworkRequest(ActiveRequest state) {
        state.networkCallback = createNetworkCallback(state, false);
        state.scheduleNetworkWaitTimeout();
        try {
            state.registerDefaultNetwork();
            Network activeNetwork = state.manager.getActiveNetwork();
            if (activeNetwork != null) {
                acceptNetworkIfUsable(state, activeNetwork,
                        state.manager.getNetworkCapabilities(activeNetwork), false);
            }
        } catch (RuntimeException error) {
            state.fail("Validated internet networking is unavailable");
        }
    }

    private ConnectivityManager.NetworkCallback createNetworkCallback(ActiveRequest state, boolean wifiOnly) {
        return new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                NetworkCapabilities capabilities = state.manager.getNetworkCapabilities(network);
                acceptNetworkIfUsable(state, network, capabilities, wifiOnly);
            }

            @Override
            public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
                if (state.isSelectedNetwork(network) && !isUsableNetwork(capabilities, wifiOnly)) {
                    state.fail(state.networkLostMessage());
                    return;
                }
                acceptNetworkIfUsable(state, network, capabilities, wifiOnly);
            }

            @Override
            public void onBlockedStatusChanged(Network network, boolean blocked) {
                if (blocked && state.isSelectedNetwork(network)) {
                    state.fail(state.wifiRequired ? "The Wi-Fi connection is blocked" : "The internet connection is blocked");
                }
            }

            @Override
            public void onLost(Network network) {
                if (state.isSelectedNetwork(network)) state.fail(state.networkLostMessage());
            }

            @Override
            public void onUnavailable() {
                if (wifiOnly) state.fail("Wi-Fi is unavailable for detailed map downloads");
            }
        };
    }

    private void acceptNetworkIfUsable(ActiveRequest state, Network network,
                                       NetworkCapabilities capabilities, boolean wifiOnly) {
        if (state.isFinished() || !isUsableNetwork(capabilities, wifiOnly)) return;
        if (!state.bindNetwork(network)) return;
        if (state.accountBackup) REQUEST_EXECUTOR.execute(() -> performAccountBackupRequest(state, network));
        else REQUEST_EXECUTOR.execute(() -> performRequest(state, network));
    }

    @PluginMethod
    public void abort(PluginCall call) {
        String requestId = call.getString("requestId");
        ActiveRequest state = requestId == null ? null : activeRequests.get(requestId);
        if (state != null) state.fail("Content request aborted");
        call.resolve();
    }

    private void performRequest(ActiveRequest state, Network network) {
        if (state.isFinished()) return;
        HttpURLConnection connection = null;
        try {
            URLConnection opened = network.openConnection(state.url);
            if (!(opened instanceof HttpURLConnection)) throw new IOException("Only HTTPS content URLs are supported");
            connection = (HttpURLConnection) opened;
            state.setConnection(connection);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod(state.method);
            connection.setConnectTimeout(state.timeoutMs);
            connection.setReadTimeout(state.timeoutMs);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept-Encoding", "identity");
            applyHeaders(connection, state.headers);

            int status = connection.getResponseCode();
            if (status < 200 || status > 599) throw new IOException("Content server returned an invalid HTTP status");
            if (status >= 300 && status < 400 && status != HttpURLConnection.HTTP_NOT_MODIFIED) {
                throw new IOException("Content server redirects are not permitted");
            }
            int declaredLength = connection.getContentLength();
            if (declaredLength > state.maxResponseBytes) throw new IOException("Content response exceeds its byte limit");

            boolean noBody = "HEAD".equals(state.method) || status == HttpURLConnection.HTTP_NO_CONTENT || status == 205 || status == HttpURLConnection.HTTP_NOT_MODIFIED;
            byte[] body = noBody ? new byte[0] : readBoundedBody(connection, status, state.maxResponseBytes, state);
            if (state.isFinished()) return;

            JSObject result = new JSObject();
            result.put("status", status);
            result.put("statusText", nullToEmpty(connection.getResponseMessage()));
            result.put("headers", responseHeaders(connection.getHeaderFields()));
            result.put("bodyBase64", Base64.encodeToString(body, Base64.NO_WRAP));
            result.put("url", state.url.toString());
            state.resolve(result);
        } catch (Exception error) {
            if (!state.isFinished()) {
                String message = error.getMessage();
                state.fail(message == null || message.isEmpty() ? "Content request failed" : message);
            }
        } finally {
            state.clearConnection(connection);
            if (connection != null) connection.disconnect();
        }
    }

    private void performAccountBackupRequest(ActiveRequest state, Network network) {
        if (state.isFinished()) return;
        HttpURLConnection connection = null;
        try {
            URLConnection opened = network.openConnection(state.url);
            if (!(opened instanceof HttpURLConnection)) throw new IOException("Only HTTPS account backup URLs are supported");
            connection = (HttpURLConnection) opened;
            state.setConnection(connection);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod(state.method);
            connection.setConnectTimeout(state.timeoutMs);
            connection.setReadTimeout(state.timeoutMs);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept-Encoding", "identity");
            applyHeaders(connection, state.headers);

            if ("PUT".equals(state.method)) {
                writeAccountBackupBody(connection, state.requestBody);
            }

            int status = connection.getResponseCode();
            if (status < 200 || status > 599) throw new IOException("Account backup server returned an invalid HTTP status");
            if (status >= 300 && status < 400 && status != HttpURLConnection.HTTP_NOT_MODIFIED) {
                throw new IOException("Account backup redirects are not permitted");
            }
            int declaredLength = connection.getContentLength();
            if (declaredLength > state.maxResponseBytes) throw new IOException("Account backup response exceeds its byte limit");

            boolean noBody = status == HttpURLConnection.HTTP_NO_CONTENT || status == 205 || status == HttpURLConnection.HTTP_NOT_MODIFIED;
            byte[] responseBody = noBody ? new byte[0] : readBoundedBody(connection, status, state.maxResponseBytes, state);
            if (state.isFinished()) return;

            JSObject result = new JSObject();
            result.put("status", status);
            result.put("statusText", nullToEmpty(connection.getResponseMessage()));
            result.put("headers", responseHeaders(connection.getHeaderFields()));
            result.put("bodyBase64", Base64.encodeToString(responseBody, Base64.NO_WRAP));
            result.put("url", state.url.toString());
            state.resolve(result);
        } catch (Exception error) {
            if (!state.isFinished()) {
                String message = error.getMessage();
                state.fail(message == null || message.isEmpty() ? "Account backup request failed" : message);
            }
        } finally {
            state.clearConnection(connection);
            if (connection != null) connection.disconnect();
        }
    }

    static URL validateAccountBackupUrl(String value, String apiOrigin, String method) throws Exception {
        URI uri = new URI(value);
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawFragment() != null) {
            throw new IllegalArgumentException("Account backup requires an approved HTTPS URL");
        }
        int port = uri.getPort();
        if (port != -1 && port != 443) throw new IllegalArgumentException("Account backup cannot use a custom port");
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        String origin = "https://" + host;
        String approvedApi = canonicalApprovedOrigin(apiOrigin, true);
        if (approvedApi == null || !origin.equals(approvedApi)) {
            throw new IllegalArgumentException("The account backup origin is not approved");
        }

        String path = uri.getRawPath();
        String query = uri.getRawQuery();
        String normalizedMethod = method == null ? "" : method;
        boolean allowed = false;
        if ("/api/claims".equals(path)) {
            allowed = "GET".equals(normalizedMethod) && (query == null || query.matches("cursor=[A-Za-z0-9_-]{1,1024}"));
        } else if (path != null && path.matches("(?i)^/api/claims/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) {
            allowed = "PUT".equals(normalizedMethod) && query == null;
        } else if (path != null && path.matches("(?i)^/api/claims/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/photo$")) {
            allowed = ("GET".equals(normalizedMethod) || "PUT".equals(normalizedMethod)) && query == null;
        }
        if (!allowed) throw new IllegalArgumentException("The account backup path or method is not approved");
        return uri.toURL();
    }

    static void validateAccountBackupBody(URL url, String method, byte[] body) {
        if (body == null) throw new IllegalArgumentException("The account backup body is invalid");
        String path = url.getPath();
        if ("GET".equals(method)) {
            if (body.length != 0) throw new IllegalArgumentException("Account backup GET requests cannot contain a body");
            return;
        }
        int maximum = path.matches("(?i)^/api/claims/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
                ? MAX_CLAIM_JSON_BYTES : MAX_ACCOUNT_BACKUP_BYTES;
        if (!"PUT".equals(method) || body.length < 1 || body.length > maximum) {
            throw new IllegalArgumentException("The account backup request body is invalid or exceeds its byte limit");
        }
    }

    static void writeAccountBackupBody(HttpURLConnection connection, byte[] requestBody) throws IOException {
        connection.setDoOutput(true);
        connection.setFixedLengthStreamingMode(requestBody.length);
        try (java.io.OutputStream output = connection.getOutputStream()) {
            output.write(requestBody);
            output.flush();
        }
    }

    static void validateAccountBackupHeaders(Map<String, String> headers, URL url, String method) {
        String authorization = headerValue(headers, "authorization");
        String accountId = headerValue(headers, "x-kip-account-id");
        String transport = headerValue(headers, "x-kip-auth-transport");
        if (authorization == null || !authorization.matches("(?i)^Bearer [^\\s]{1,4096}$")) {
            throw new IllegalArgumentException("Native account backup requires a bearer session");
        }
        if (accountId == null || !accountId.matches("(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) {
            throw new IllegalArgumentException("Native account backup requires an account scope");
        }
        if (!"native".equals(transport)) throw new IllegalArgumentException("Native account backup requires the native transport marker");
        if (headerValue(headers, "cookie") != null) throw new IllegalArgumentException("Native account backup does not accept cookies");
        if ("PUT".equals(method)) {
            String rawContentType = headerValue(headers, "content-type");
            String contentType = rawContentType == null ? "" : rawContentType.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
            String path = url.getPath();
            boolean allowed = path.matches("(?i)^/api/claims/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
                    ? "application/json".equals(contentType)
                    : "image/jpeg".equals(contentType) || "image/png".equals(contentType) || "image/webp".equals(contentType);
            if (!allowed) throw new IllegalArgumentException("Native account backup content type is not approved for this route");
        }
    }

    private static Map<String, String> accountHeaders(JSObject headers) throws JSONException {
        Map<String, String> result = new java.util.HashMap<>();
        if (headers == null) return result;
        Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
            String name = keys.next();
            Object value = headers.get(name);
            if (value != null && value != JSONObjectNull.VALUE) result.put(name, String.valueOf(value));
        }
        return result;
    }

    private static String headerValue(Map<String, String> headers, String expectedName) {
        if (headers == null) return null;
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (expectedName.equals(entry.getKey().toLowerCase(Locale.ROOT))) return entry.getValue();
        }
        return null;
    }

    private static byte[] readBoundedBody(HttpURLConnection connection, int status, int maxBytes, ActiveRequest state) throws IOException {
        InputStream input = null;
        try {
            input = status >= HttpURLConnection.HTTP_BAD_REQUEST ? connection.getErrorStream() : connection.getInputStream();
            if (input == null) return new byte[0];
            ByteArrayOutputStream output = new ByteArrayOutputStream(Math.min(maxBytes, 64 * 1024));
            byte[] buffer = new byte[READ_BUFFER_BYTES];
            int total = 0;
            int read;
            while ((read = input.read(buffer)) != -1) {
                if (state.isFinished()) throw new IOException("Content request aborted");
                total += read;
                if (total > maxBytes) throw new IOException("Content response exceeds its byte limit");
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        } finally {
            if (input != null) input.close();
        }
    }

    private static void applyHeaders(HttpURLConnection connection, JSObject headers) throws JSONException {
        if (headers == null) return;
        Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
            String name = keys.next();
            String lower = name.toLowerCase(Locale.ROOT);
            if (BLOCKED_HEADERS.contains(lower) || lower.startsWith("proxy-") || lower.startsWith("sec-")) continue;
            Object raw = headers.get(name);
            if (raw == null || raw == JSONObjectNull.VALUE) continue;
            String value = String.valueOf(raw);
            if (!isHttpToken(name) || value.indexOf('\r') >= 0 || value.indexOf('\n') >= 0) {
                throw new JSONException("The content request contains an invalid header");
            }
            connection.setRequestProperty(name, value);
        }
    }

    private static boolean isHttpToken(String value) {
        if (value.isEmpty()) return false;
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            boolean alphaNumeric = character >= 'a' && character <= 'z'
                    || character >= 'A' && character <= 'Z'
                    || character >= '0' && character <= '9';
            if (!alphaNumeric && "!#$%&'*+-.^_`|~".indexOf(character) < 0) return false;
        }
        return true;
    }

    private static JSObject responseHeaders(Map<String, List<String>> fields) throws JSONException {
        JSObject headers = new JSObject();
        if (fields == null) return headers;
        for (Map.Entry<String, List<String>> entry : fields.entrySet()) {
            String name = entry.getKey();
            List<String> values = entry.getValue();
            if (name == null || values == null || values.isEmpty()) continue;
            String lower = name.toLowerCase(Locale.ROOT);
            if ("set-cookie".equals(lower) || "set-cookie2".equals(lower)) continue;
            headers.put(lower, String.join(", ", values));
        }
        return headers;
    }

    static URL validateContentUrl(String value, String apiOrigin, String cdnOrigin) throws Exception {
        URI uri = new URI(value);
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawFragment() != null) {
            throw new IllegalArgumentException("Content downloads require an approved HTTPS URL");
        }
        int port = uri.getPort();
        if (port != -1 && port != 443) throw new IllegalArgumentException("Content downloads cannot use a custom port");
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        String origin = "https://" + host;
        String approvedApi = canonicalApprovedOrigin(apiOrigin, true);
        String approvedCdn = canonicalApprovedOrigin(cdnOrigin, false);
        boolean approvedRequest = (origin.equals(approvedApi) && isApprovedApiHost(host))
                || (origin.equals(approvedCdn) && isApprovedCdnHost(host));
        if (!approvedRequest) {
            throw new IllegalArgumentException("The content URL origin is not approved");
        }
        return uri.toURL();
    }

    static NetworkPolicy networkPolicyForRequest(URL url, boolean accountBackup) {
        return networkPolicyForRequest(url, accountBackup, false);
    }

    static NetworkPolicy networkPolicyForRequest(URL url, boolean accountBackup, boolean anyNetwork) {
        if (accountBackup || anyNetwork) return NetworkPolicy.ANY_VALIDATED;
        try {
            String path = url.toURI().getPath();
            return WIFI_ONLY_MAP_CHUNK_PATH.matcher(path).find()
                    ? NetworkPolicy.WIFI_VALIDATED
                    : NetworkPolicy.ANY_VALIDATED;
        } catch (Exception ignored) {
            // A URL is validated before this policy is applied. Fail closed if that invariant changes.
            return NetworkPolicy.WIFI_VALIDATED;
        }
    }

    enum NetworkPolicy {
        ANY_VALIDATED,
        WIFI_VALIDATED
    }

    private static String canonicalApprovedOrigin(String value, boolean apiOrigin) throws Exception {
        if (value == null || value.isEmpty()) return null;
        URI uri = new URI(value);
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null) return null;
        int port = uri.getPort();
        if (port != -1 && port != 443) return null;
        String host = uri.getHost().toLowerCase(Locale.ROOT);
        if (apiOrigin ? !isApprovedApiHost(host) : !isApprovedCdnHost(host)) return null;
        String path = uri.getRawPath();
        if (path != null && !path.isEmpty() && !"/".equals(path)) return null;
        String origin = "https://" + host;
        if (!apiOrigin && !APPROVED_CDN_ORIGIN.equals(origin)) return null;
        return origin;
    }

    private static boolean isApprovedApiHost(String host) {
        return "staging.web.parkdex.app".equals(host)
                || "web.parkdex.app".equals(host)
                || "parkdex-kip-staging.vercel.app".equals(host)
                || "parkdex-kip.vercel.app".equals(host)
                || (!BuildConfig.CONTENT_API_HOST.isEmpty()
                && BuildConfig.CONTENT_API_HOST.equalsIgnoreCase(host));
    }

    private static boolean isApprovedCdnHost(String host) {
        return "kip-assets.parkdex.app".equals(host);
    }

    private static boolean isUsableWifi(NetworkCapabilities capabilities) {
        return capabilities != null
                && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
    }

    private static boolean isUsableNetwork(NetworkCapabilities capabilities, boolean wifiOnly) {
        return capabilities != null
                && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                && (!wifiOnly || capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI));
    }

    private ConnectivityManager connectivityManager() {
        return (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
    }

    boolean acceptsRequests() {
        synchronized (lifecycleLock) {
            return !stopped && !destroyed;
        }
    }

    private void failActiveRequests(String message) {
        for (ActiveRequest state : new ArrayList<>(activeRequests.values())) state.fail(message);
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }

    private final class ActiveRequest {
        final String requestId;
        final PluginCall call;
        final ConnectivityManager manager;
        final URL url;
        final String method;
        final JSObject headers;
        final int maxResponseBytes;
        final int timeoutMs;
        final boolean accountBackup;
        final boolean wifiRequired;
        final byte[] requestBody;
        final AtomicBoolean finished = new AtomicBoolean(false);
        private final Object registrationLock = new Object();
        private boolean callbackRegistered;
        volatile ConnectivityManager.NetworkCallback networkCallback;
        volatile Network selectedNetwork;
        volatile HttpURLConnection connection;
        volatile ScheduledFuture<?> networkWaitTimeout;

        ActiveRequest(String requestId, PluginCall call, ConnectivityManager manager, URL url, String method,
                      JSObject headers, int maxResponseBytes, int timeoutMs, boolean anyNetwork) {
            this(requestId, call, manager, url, method, headers, maxResponseBytes, timeoutMs, false, anyNetwork, new byte[0]);
        }

        ActiveRequest(String requestId, PluginCall call, ConnectivityManager manager, URL url, String method,
                      JSObject headers, int maxResponseBytes, int timeoutMs, boolean accountBackup, byte[] requestBody) {
            this(requestId, call, manager, url, method, headers, maxResponseBytes, timeoutMs, accountBackup, false, requestBody);
        }

        ActiveRequest(String requestId, PluginCall call, ConnectivityManager manager, URL url, String method,
                      JSObject headers, int maxResponseBytes, int timeoutMs, boolean accountBackup, boolean anyNetwork,
                      byte[] requestBody) {
            this.requestId = requestId;
            this.call = call;
            this.manager = manager;
            this.url = url;
            this.method = method;
            this.headers = headers;
            this.maxResponseBytes = maxResponseBytes;
            this.timeoutMs = timeoutMs;
            this.accountBackup = accountBackup;
            this.wifiRequired = networkPolicyForRequest(url, accountBackup, anyNetwork) == NetworkPolicy.WIFI_VALIDATED;
            this.requestBody = requestBody;
        }

        String networkLostMessage() {
            if (wifiRequired) return "The Wi-Fi connection was lost";
            return accountBackup ? "The internet connection was lost during account backup" : "The internet connection was lost during content download";
        }

        synchronized boolean bindNetwork(Network network) {
            if (isFinished()) return false;
            if (selectedNetwork == null) {
                selectedNetwork = network;
                cancelNetworkWaitTimeout();
                return true;
            }
            if (selectedNetwork.equals(network)) return false;
            fail(wifiRequired ? "The Wi-Fi connection changed during a content request" :
                    (accountBackup ? "The internet connection changed during account backup" : "The internet connection changed during content download"));
            return false;
        }

        boolean isSelectedNetwork(Network network) {
            return selectedNetwork != null && selectedNetwork.equals(network);
        }

        boolean isFinished() {
            return finished.get();
        }

        void registerNetwork(NetworkRequest request) {
            synchronized (registrationLock) {
                if (isFinished()) return;
                manager.registerNetworkCallback(request, networkCallback);
                callbackRegistered = true;
            }
        }

        void registerDefaultNetwork() {
            synchronized (registrationLock) {
                if (isFinished()) return;
                manager.registerDefaultNetworkCallback(networkCallback);
                callbackRegistered = true;
            }
        }

        void scheduleNetworkWaitTimeout() {
            networkWaitTimeout = NETWORK_TIMEOUT_EXECUTOR.schedule(
                    () -> fail(wifiRequired
                            ? "Validated Wi-Fi is unavailable for detailed map downloads"
                            : (accountBackup
                                    ? "A validated internet connection is unavailable for account backup"
                                    : "A validated internet connection is unavailable for content downloads")),
                    NETWORK_WAIT_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        }

        private void cancelNetworkWaitTimeout() {
            ScheduledFuture<?> timeout = networkWaitTimeout;
            networkWaitTimeout = null;
            if (timeout != null) timeout.cancel(false);
        }

        void setConnection(HttpURLConnection value) {
            connection = value;
            if (isFinished() && value != null) value.disconnect();
        }

        void clearConnection(HttpURLConnection value) {
            if (connection == value) connection = null;
        }

        void resolve(JSObject result) {
            if (!finished.compareAndSet(false, true)) return;
            cleanup();
            call.resolve(result);
        }

        void fail(String message) {
            if (!finished.compareAndSet(false, true)) return;
            HttpURLConnection current = connection;
            if (current != null) current.disconnect();
            cleanup();
            call.reject(message);
        }

        private void cleanup() {
            activeRequests.remove(requestId, this);
            cancelNetworkWaitTimeout();
            ConnectivityManager.NetworkCallback callback = networkCallback;
            synchronized (registrationLock) {
                if (callbackRegistered && callback != null) {
                    callbackRegistered = false;
                    try {
                        manager.unregisterNetworkCallback(callback);
                    } catch (IllegalArgumentException ignored) {
                        // A timed out request is released by Android automatically.
                    } catch (SecurityException ignored) {
                        // The request is already no longer usable.
                    }
                }
            }
        }
    }

    /** Placeholder used to avoid putting JSONObject.NULL into outgoing headers. */
    private static final class JSONObjectNull {
        static final Object VALUE = org.json.JSONObject.NULL;
    }
}
