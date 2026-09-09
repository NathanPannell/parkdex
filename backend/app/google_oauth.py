from urllib.parse import urlencode

import httpx
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token

from backend.app.settings import Settings

AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"


def authorization_url(settings: Settings, state: str, nonce: str, code_challenge: str) -> str:
    if not settings.google_client_id or not settings.google_client_secret or not settings.google_redirect_uri:
        raise RuntimeError("Google sign-in is not configured")
    query = urlencode({"client_id": settings.google_client_id, "redirect_uri": settings.google_redirect_uri, "response_type": "code", "scope": "openid email", "state": state, "nonce": nonce, "code_challenge": code_challenge, "code_challenge_method": "S256", "prompt": "select_account"})
    return f"{AUTHORIZATION_ENDPOINT}?{query}"


def exchange_and_verify(settings: Settings, code: str, code_verifier: str) -> dict:
    if not settings.google_client_id or not settings.google_client_secret or not settings.google_redirect_uri:
        raise RuntimeError("Google sign-in is not configured")
    response = httpx.post(TOKEN_ENDPOINT, data={"client_id": settings.google_client_id, "client_secret": settings.google_client_secret, "code": code, "code_verifier": code_verifier, "grant_type": "authorization_code", "redirect_uri": settings.google_redirect_uri}, timeout=settings.request_timeout_seconds)
    response.raise_for_status()
    raw_id_token = response.json().get("id_token")
    if not raw_id_token:
        raise ValueError("Google did not return an ID token")
    return id_token.verify_oauth2_token(raw_id_token, google_requests.Request(), settings.google_client_id)
